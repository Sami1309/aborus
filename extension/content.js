const SIDEBAR_ID = 'modeler-recorder-sidebar';
const SIDEBAR_WIDTH = 340;
const SIDEBAR_COLLAPSED_WIDTH = 40;
const sessionParams = new URLSearchParams(window.location.search);
const hashParams = new URLSearchParams(window.location.hash ? window.location.hash.replace(/^#/, '') : '');

function getParam(name) {
  return sessionParams.get(name) || hashParams.get(name) || null;
}

let sessionId = getParam('session') || getParam('modeler_session');
const automationRunParam = getParam('automation_run');
let events = [];
let rawEvents = [];
let automationState = {
  runId: automationRunParam || null,
  steps: [],
  status: 'idle',
  engine: (getParam('automation_engine') || '').toLowerCase() || null,
  automationId: getParam('automation_id') || null,
  name: 'Automation Run',
};
const apiOriginHint = getParam('modeler_origin');
let sessionConfig = null;
let sessionConfigPromise = null;
let sessionIdentityPromise = null;
let domListenersBound = false;
const lastInputEvent = new WeakMap();
const INPUT_EVENT_DEBOUNCE_MS = 400;
const ignoredRecordingPaths = ['/web/test-page.html'];
const STEP_DELAY_MS = 600;
const NAVIGATION_EVENTS = new Set(['navigate', 'redirect', 'location', 'urlchange', 'hashchange']);

let automationRunStarted = false;
let cachedApiBase = null;
let tabBindingPromise = null;
let recorderInitialised = false;
let appInitialised = false;

if (sessionId) {
  bindSessionToTab(sessionId);
} else {
  resolveSessionIdentity();
}

function isDemoPage() {
  try {
    const url = new URL(window.location.href);
    return ignoredRecordingPaths.some((suffix) => url.pathname.endsWith(suffix));
  } catch (error) {
    return false;
  }
}

function getApiBaseOverride(config) {
  if (typeof config?.apiBase === 'string' && config.apiBase) {
    return config.apiBase;
  }
  if (typeof apiOriginHint === 'string' && apiOriginHint) {
    return apiOriginHint;
  }
  return null;
}

async function resolveApiBase() {
  if (cachedApiBase) {
    return cachedApiBase;
  }
  try {
    const config = await ensureSessionConfig();
    const override = getApiBaseOverride(config);
    if (override) {
      cachedApiBase = override.replace(/\/+$/, '');
      return cachedApiBase;
    }
  } catch (error) {
    console.warn('Modeler configuration unavailable', error);
  }
  try {
    cachedApiBase = new URL(window.location.href).origin;
  } catch (error) {
    cachedApiBase = window.location.origin;
  }
  return cachedApiBase;
}

function bindSessionToTab(id) {
  if (!id) return;
  if (tabBindingPromise) {
    return;
  }
  tabBindingPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'modeler_bind_tab_session', sessionId: id },
      () => {
        tabBindingPromise = null;
        resolve();
      },
    );
  });
}

function resolveSessionIdentity() {
  if (sessionId) {
    bindSessionToTab(sessionId);
    return Promise.resolve(sessionId);
  }
  if (sessionIdentityPromise) {
    return sessionIdentityPromise;
  }
  sessionIdentityPromise = new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'modeler_resume_session' },
      (response) => {
        sessionIdentityPromise = null;
        if (chrome.runtime.lastError) {
          console.warn('Modeler session resume failed', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        const recovered = response?.sessionId || null;
        if (recovered) {
          sessionId = recovered;
          bindSessionToTab(sessionId);
          if (response?.config) {
            sessionConfig = response.config;
          }
          if (rawEvents.length) {
            events = rawEvents.filter((event) => !event.sessionId || event.sessionId === sessionId);
            render();
          }
        }
        resolve(sessionId);
      },
    );
  });
  return sessionIdentityPromise;
}

function automationInFlight(status) {
  if (!automationState.runId) return false;
  const value = (status || automationState.status || '').toLowerCase();
  return ['running', 'pending', 'queued', 'started'].includes(value);
}

function emitAutomationEvent(kind, payload = {}) {
  const runId = payload.runId || automationState.runId || automationRunParam;
  const enriched = { ...payload, runId };
  if (!enriched.automationId && automationState.automationId) {
    enriched.automationId = automationState.automationId;
  }
  if (!enriched.engine && automationState.engine) {
    enriched.engine = automationState.engine;
  }
  handleAutomationMessage(kind, enriched);
  forwardToBackground(kind, enriched);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function highlightElement(element) {
  if (!(element instanceof HTMLElement)) return () => {};
  element.classList.add('modeler-automation-highlight');
  try {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  } catch (error) {
    // Ignore scroll issues for elements that cannot be scrolled into view
  }
  return () => {
    element.classList.remove('modeler-automation-highlight');
  };
}

function readStepValue(step) {
  const hints = step?.hints || {};
  if (hints.user_value !== undefined && hints.user_value !== null) return hints.user_value;
  if (hints.value !== undefined && hints.value !== null) return hints.value;
  if (hints.text !== undefined && hints.text !== null) return hints.text;
  if (hints.input !== undefined && hints.input !== null) return hints.input;
  return '';
}

function normaliseSelectors(step) {
  const selectors = [];
  const raw = Array.isArray(step?.dom_selectors) && step.dom_selectors.length
    ? step.dom_selectors
    : Array.isArray(step?.selectors)
      ? step.selectors
      : [];
  raw.forEach((item) => {
    if (typeof item === 'string' && item.trim().length) {
      selectors.push(item.trim());
    }
  });
  return selectors;
}

async function performStepAction(step) {
  const selectors = normaliseSelectors(step);
  if (!selectors.length) {
    return { outcome: 'skipped', message: 'No selectors available for this step.' };
  }

  let lastError = null;
  for (const selector of selectors) {
    let element;
    try {
      element = document.querySelector(selector);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!element) {
      lastError = new Error(`Selector not found: ${selector}`);
      continue;
    }

    const cleanup = highlightElement(element);
    const mode = (step?.execution_mode || 'deterministic').toLowerCase();
    try {
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        const value = readStepValue(step);
        element.focus();
        if (value !== undefined && value !== null && value !== '') {
          element.value = value;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (element instanceof HTMLSelectElement) {
        const value = readStepValue(step);
        if (value !== undefined && value !== null && value !== '') {
          element.value = value;
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (element instanceof HTMLFormElement) {
        if (typeof element.requestSubmit === 'function') {
          element.requestSubmit();
        } else {
          element.submit();
        }
      } else {
        if (typeof element.focus === 'function') element.focus();
        if (typeof element.click === 'function') element.click();
      }
      await delay(200);
      return {
        outcome: 'succeeded',
        message: `Executed step via ${selector} (${mode}).`,
        selector,
      };
    } catch (error) {
      lastError = error;
    } finally {
      cleanup();
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('Automation step could not locate any selectors.');
}

async function reportRunProgress(stepIndex, status, message, details) {
  if (!automationState.runId) return;
  try {
    const apiBase = await resolveApiBase();
    if (!apiBase) {
      throw new Error('Modeler API base unavailable');
    }
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'modeler_run_progress',
          runId: automationState.runId,
          apiBase,
          payload: {
            step_index: stepIndex,
            status,
            message,
            details,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || 'Run progress update failed'));
            return;
          }
          resolve(response.result || null);
        },
      );
    });
  } catch (error) {
    console.warn('Unable to report automation progress', error);
  }
}

async function fetchAutomationRun(runId) {
  const apiBase = await resolveApiBase();
  if (!apiBase) {
    throw new Error('Modeler API base unavailable');
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'modeler_fetch_run',
        runId,
        apiBase,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || `Run ${runId} not found`));
          return;
        }
        resolve(response.run);
      },
    );
  });
}

async function executeAutomationStep(step, index) {
  const title = step?.title || `Step ${index + 1}`;
  const description = step?.description || title;
  emitAutomationEvent('automation_progress', {
    stepIndex: index,
    status: 'started',
    step,
  });
  await reportRunProgress(index, 'started', `Starting ${title}`, { description });
  await delay(STEP_DELAY_MS);

  try {
    const mode = (step?.execution_mode || 'deterministic').toLowerCase();
    if (mode === 'llm') {
      // Execute LLM step using browser-use on the backend
      await reportRunProgress(index, 'running', `Executing ${title} with LLM...`, { execution_mode: 'llm' });

      try {
        const apiBase = await resolveApiBase();
        if (!apiBase) {
          throw new Error('Modeler API base unavailable');
        }

        const response = await fetch(`${apiBase}/execute/llm-step`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            step: step,
            context: {
              url: window.location.href,
              title: document.title,
            },
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.detail || `LLM execution failed: ${response.statusText}`);
        }

        const data = await response.json();
        const result = data.result || {};

        if (result.outcome === 'succeeded') {
          await reportRunProgress(index, 'succeeded', `${title} completed with LLM.`, {
            execution_mode: 'llm',
            result: result.message
          });
          emitAutomationEvent('automation_progress', {
            stepIndex: index,
            status: 'succeeded',
            step,
            llm_result: result,
          });
        } else {
          throw new Error(result.message || 'LLM step failed');
        }
      } catch (llmError) {
        const message = llmError?.message || String(llmError);
        await reportRunProgress(index, 'failed', `${title} (LLM) failed: ${message}`, {
          execution_mode: 'llm',
          error: message
        });
        throw llmError;
      }
      return;
    }

    const result = await performStepAction(step);
    const outcomeStatus = result.outcome === 'skipped' ? 'skipped' : 'succeeded';
    await reportRunProgress(index, outcomeStatus, result.message, { selector: result.selector });
    emitAutomationEvent('automation_progress', {
      stepIndex: index,
      status: outcomeStatus,
      step,
      selector: result.selector,
    });
  } catch (error) {
    const message = error?.message || String(error);
    await reportRunProgress(index, 'failed', `${title} failed: ${message}`, { error: message });
    emitAutomationEvent('automation_progress', {
      stepIndex: index,
      status: 'failed',
      step,
      error: message,
    });
    const failure = error instanceof Error ? error : new Error(message);
    failure.stepIndex = index;
    throw failure;
  }
}

async function startAutomationRunIfNeeded() {
  if (automationRunStarted) return;
  if (!automationState.runId) return;
  if (isDemoPage()) return;
  await resolveSessionIdentity();
  automationRunStarted = true;

  let run;
  try {
    run = await fetchAutomationRun(automationState.runId);
  } catch (error) {
    console.error('Unable to load automation run', error);
    await reportRunProgress(0, 'failed', error?.message || 'Failed to load automation run.', {
      reason: error?.message || 'Failed to load automation run.',
    });
    emitAutomationEvent('automation_complete', {
      status: 'failed',
      message: error?.message || 'Failed to load automation run.',
    });
    return;
  }

  const steps = Array.isArray(run.steps) ? run.steps : [];
  const runStatus = (run.status || 'running').toLowerCase();

  emitAutomationEvent('automation_init', {
    runId: automationState.runId,
    automationId: run.automation_id || automationState.automationId,
    engine: run.engine || automationState.engine,
    status: runStatus,
    automationName: run.automation_name || run.name || automationState.name,
    steps,
  });

  if (!steps.length) {
    emitAutomationEvent('automation_complete', {
      status: 'succeeded',
      message: 'Automation completed (no steps).',
    });
    return;
  }

  let failure = null;
  for (let index = 0; index < steps.length; index += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await executeAutomationStep(steps[index], index);
    } catch (error) {
      failure = error;
      break;
    }
  }

  if (failure) {
    const message = failure?.message || 'Automation failed.';
    const stepIndex = typeof failure.stepIndex === 'number' ? failure.stepIndex : 0;
    await reportRunProgress(stepIndex, 'failed', message, { reason: message });
    emitAutomationEvent('automation_complete', {
      status: 'failed',
      message,
    });
    return;
  }

  await reportRunProgress(steps.length - 1, 'completed', 'Automation completed successfully.', {});
  emitAutomationEvent('automation_complete', { status: 'succeeded' });
}

function ensureSessionConfig() {
  if (sessionConfig) {
    return Promise.resolve(sessionConfig);
  }
  if (sessionConfigPromise) {
    return sessionConfigPromise;
  }
  sessionConfigPromise = resolveSessionIdentity().then((id) => {
    if (!id) {
      sessionConfigPromise = null;
      return null;
    }
    if (sessionConfig) {
      sessionConfigPromise = null;
      return sessionConfig;
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'modeler_get_session_config', sessionId: id },
        (response) => {
          sessionConfigPromise = null;
          if (chrome.runtime.lastError) {
            console.warn('Modeler session config unavailable', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          sessionConfig = response?.config || null;
          resolve(sessionConfig);
        },
      );
    });
  });
  return sessionConfigPromise;
}

function onReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

function setBodyOffset(width) {
  document.documentElement.style.marginRight = `${width}px`;
  document.documentElement.style.transition = 'margin-right 0.2s ease';
}

function resetBodyOffset() {
  document.documentElement.style.marginRight = '';
  document.documentElement.style.transition = '';
}

function createSidebar() {
  if (document.getElementById(SIDEBAR_ID)) return;
  const container = document.createElement('aside');
  container.id = SIDEBAR_ID;
  container.innerHTML = `
    <div class="modeler-header">
      <div class="title">
        <strong>Recorder Monitor</strong>
        <span class="badge">Live</span>
      </div>
      <button type="button" class="collapse" aria-label="Collapse monitor">⟨</button>
    </div>
    <div class="modeler-body">
      <section id="modeler-automation" class="automation hidden">
        <div class="automation-header">
          <div>
            <strong id="modeler-automation-title">Automation Run</strong>
            <span id="modeler-automation-status" class="status-pill">Idle</span>
          </div>
          <small id="modeler-automation-engine" class="muted"></small>
        </div>
        <ul id="modeler-automation-steps" class="automation-steps"></ul>
      </section>
      <div id="modeler-empty" class="empty">Waiting for activity…</div>
      <ul id="modeler-events" class="events"></ul>
    </div>
  `;
  document.body.append(container);

  const collapseBtn = container.querySelector('.collapse');
  collapseBtn?.addEventListener('click', () => {
    const collapsed = container.classList.toggle('collapsed');
    collapseBtn.textContent = collapsed ? '⟩' : '⟨';
    if (collapsed) {
      setBodyOffset(SIDEBAR_COLLAPSED_WIDTH);
    } else {
      setBodyOffset(SIDEBAR_WIDTH);
    }
  });

  setBodyOffset(SIDEBAR_WIDTH);
}

function render() {
  renderAutomation();
  const list = document.getElementById('modeler-events');
  const empty = document.getElementById('modeler-empty');
  if (!list || !empty) return;

  if (automationInFlight()) {
    empty.style.display = 'block';
    empty.textContent = 'Automation in progress…';
    list.innerHTML = '';
    return;
  }

  if (!events.length) {
    empty.style.display = 'block';
    empty.textContent = 'Waiting for activity…';
    list.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = events
    .map((event) => {
      const formatted = formatEvent(event);
      const extra = formatted.extra ? `<div class="extra">${formatted.extra}</div>` : '';
      return `
        <li class="event">
          <header>
            <span class="type">${formatted.type}</span>
            <time>${formatted.time}</time>
          </header>
          <div class="detail">${formatted.detail}</div>
          ${extra}
        </li>
      `;
    })
    .join('');
}

function formatEvent(event) {
  const time = new Date(event.receivedAt || Date.now()).toLocaleTimeString();
  if (event.kind === 'summary') {
    const node = event?.payload || {};
    const intent = node.intent || {};
    const selectors = Array.isArray(node.selectors) ? node.selectors.slice(0, 2) : [];
    return {
      type: 'Flow summary',
      detail: intent.summary || 'No summary available',
      time,
      extra: selectors.length ? `Selectors: ${selectors.join(', ')}` : null,
    };
  }

  const payload = event?.payload || {};
  const detailSource = payload.payload || payload;
  const detail = JSON.stringify(detailSource, null, 0);
  const target = payload.dom;
  const extra = target ? `Target: ${target.tag}${target.attributes?.id ? `#${target.attributes.id}` : ''}` : null;
  return {
    type: payload.category || payload.type || 'event',
    detail,
    time,
    extra,
  };
}

function renderAutomation() {
  const wrapper = document.getElementById('modeler-automation');
  if (!wrapper) return;
  const stepsList = document.getElementById('modeler-automation-steps');
  const statusEl = document.getElementById('modeler-automation-status');
  const engineEl = document.getElementById('modeler-automation-engine');
  const titleEl = document.getElementById('modeler-automation-title');

  if (!automationState.runId || !automationState.steps.length) {
    wrapper.classList.add('hidden');
    if (statusEl) statusEl.textContent = 'Idle';
    if (statusEl) statusEl.dataset.status = 'idle';
    if (stepsList) {
      stepsList.innerHTML = '<li class="automation-step muted">Run an automation to see live progress.</li>';
    }
    return;
  }

  wrapper.classList.remove('hidden');
  if (titleEl) {
    titleEl.textContent = automationState.name || 'Automation Run';
  }
  if (statusEl) {
    const status = automationState.status || 'running';
    const readable = status.charAt(0).toUpperCase() + status.slice(1);
    statusEl.textContent = readable;
    statusEl.dataset.status = status;
  }
  if (engineEl) {
    engineEl.textContent = automationState.engine ? `Engine: ${automationState.engine}` : '';
  }
  if (!stepsList) return;

  const fragments = automationState.steps.map((step, index) => {
    const status = step.status || 'pending';
    const classes = ['automation-step'];
    if (status === 'running') classes.push('current');
    if (status === 'succeeded') classes.push('completed');
    if (status === 'skipped') classes.push('skipped');
    if (status === 'failed') classes.push('failed');
    const selector = Array.isArray(step.dom_selectors) && step.dom_selectors.length ? step.dom_selectors[0] : null;
    const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
    const description = step.description ? `<p class="step-description">${step.description}</p>` : '';
    const selectorTag = selector ? `<code class="step-selector">${selector}</code>` : '';
    return `
      <li class="${classes.join(' ')}" data-step-index="${index}">
        <div class="step-header">
          <span class="step-order">${index + 1}</span>
          <div class="step-copy">
            <strong>${step.title || `Step ${index + 1}`}</strong>
            ${description}
            ${selectorTag}
          </div>
          <span class="step-status">${statusLabel}</span>
        </div>
      </li>
    `;
  });

  stepsList.innerHTML = fragments.join('');
}

function normaliseAutomationSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((step, index) => ({
      ...step,
      index,
      order: typeof step?.order === 'number' ? step.order : index + 1,
      status: (step?.status || 'pending').toLowerCase(),
    }))
    .sort((a, b) => {
      const orderA = typeof a.order === 'number' ? a.order : a.index;
      const orderB = typeof b.order === 'number' ? b.order : b.index;
      return orderA - orderB;
    });
}

function setAutomationState(partial) {
  const next = { ...automationState, ...partial };
  if (partial.steps !== undefined) {
    next.steps = normaliseAutomationSteps(partial.steps);
  }
  automationState = next;
  render();
}

function createEventId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `evt-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

function isSidebarElement(element) {
  if (!element) return false;
  return Boolean(element.closest && element.closest(`#${SIDEBAR_ID}`));
}

function computeCssPath(element, limit = 6) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
  const segments = [];
  let cursor = element;
  while (cursor && cursor.nodeType === Node.ELEMENT_NODE && segments.length < limit) {
    let selector = cursor.nodeName.toLowerCase();
    if (cursor.id) {
      selector += `#${cursor.id}`;
      segments.unshift(selector);
      break;
    }
    if (cursor.classList && cursor.classList.length) {
      selector += `.${Array.from(cursor.classList).slice(0, 2).join('.')}`;
    }
    if (cursor.parentElement) {
      const siblings = Array.from(cursor.parentElement.children);
      const index = siblings.indexOf(cursor);
      if (index > 0) {
        selector += `:nth-child(${index + 1})`;
      }
    }
    segments.unshift(selector);
    cursor = cursor.parentElement;
  }
  return segments.join(' > ');
}

function buildDomSnapshot(element) {
  if (!(element instanceof Element)) return null;
  const snapshot = {
    tag: element.tagName.toLowerCase(),
    attributes: {},
    accessibleName: null,
    innerText: null,
    classList: Array.from(element.classList || []),
    cssPath: computeCssPath(element),
  };
  const attrs = snapshot.attributes;
  if (element.id) attrs.id = element.id;
  const role = element.getAttribute('role');
  if (role) attrs.role = role;
  const type = element.getAttribute('type');
  if (type) attrs.type = type;
  const dataAction = element.getAttribute('data-action');
  if (dataAction) attrs['data-action'] = dataAction;
  if (element instanceof HTMLAnchorElement && element.href) {
    attrs.href = element.href;
  }
  if (element instanceof HTMLButtonElement && element.value) {
    attrs.value = element.value;
  }
  const ariaLabel = element.getAttribute('aria-label');
  const nameCandidate = ariaLabel || element.textContent || element.innerText || null;
  snapshot.accessibleName = nameCandidate ? sanitiseValue(nameCandidate.trim(), 200) : null;
  snapshot.innerText = sanitiseValue(element.innerText, 400);
  return snapshot;
}

function sanitiseValue(value, maxLength = 200) {
  if (value == null) return null;
  const stringified = String(value);
  if (stringified.length <= maxLength) return stringified;
  return `${stringified.slice(0, maxLength)}…`;
}

function normaliseInputPayload(target) {
  if (!(target instanceof Element)) return {};
  const payload = {
    name: target.getAttribute('name') || target.id || null,
    tag: target.tagName.toLowerCase(),
  };
  if (target instanceof HTMLInputElement) {
    payload.type = target.type || 'text';
    if (target.type === 'password') {
      payload.value = '[redacted]';
    } else if (target.type === 'checkbox' || target.type === 'radio') {
      payload.value = target.checked;
    } else {
      payload.value = sanitiseValue(target.value);
    }
  } else if (target instanceof HTMLTextAreaElement) {
    payload.type = 'textarea';
    payload.value = sanitiseValue(target.value);
  } else if (target instanceof HTMLSelectElement) {
    payload.type = 'select';
    payload.value = sanitiseValue(target.value);
  }
  return payload;
}

function normaliseClickPayload(target, event) {
  if (!(target instanceof Element)) return {};
  const payload = {
    tag: target.tagName.toLowerCase(),
    text: sanitiseValue(target.innerText || target.textContent, 140),
    button: event?.button ?? 0,
  };
  if (target instanceof HTMLAnchorElement && target.href) {
    payload.href = target.href;
  }
  if (target instanceof HTMLButtonElement && target.value) {
    payload.value = sanitiseValue(target.value);
  }
  return payload;
}

function buildFormPayload(form) {
  if (!(form instanceof HTMLFormElement)) return {};
  const data = {};
  try {
    const formData = new FormData(form);
    for (const [key, value] of formData.entries()) {
      data[key] = typeof value === 'string' ? sanitiseValue(value) : '[file]';
    }
  } catch (error) {
    console.warn('Unable to serialise form data', error);
  }
  return {
    action: form.action || null,
    method: (form.method || 'get').toLowerCase(),
    fields: data,
  };
}

function dispatchRecord(payload) {
  return ensureSessionConfig().then(async (config) => {
    const id = await resolveSessionIdentity();
    if (!id) {
      console.warn('Modeler recorder missing session id; skipping event dispatch');
      return null;
    }
    const apiBase = getApiBaseOverride(config);
    if (!apiBase) {
      console.warn('Modeler recorder missing API base URL; skipping event dispatch');
      return null;
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'modeler_record_event', sessionId: id, event: payload, apiBase },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error('Failed to record event via background', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          if (response?.ok && response.node) {
            forwardToBackground('summary', response.node);
          } else if (response && response.error) {
            console.error('Recorder event rejected', response.error, response);
          }
          resolve(response || null);
        },
      );
    });
  });
}

function recordDomEvent(category, element, payload = {}) {
  if (isSidebarElement(element)) return;
  const body = {
    event_id: createEventId(),
    timestamp: new Date().toISOString(),
    category,
    url: window.location.href,
    title: document.title,
    dom: null,
    payload,
  };
  if (element && !NAVIGATION_EVENTS.has((category || '').toLowerCase())) {
    body.dom = buildDomSnapshot(element);
  }
  forwardToBackground('raw', body);
  dispatchRecord(body);
}

function shouldRecordEvent(event) {
  if (!sessionId) {
    resolveSessionIdentity();
    return false;
  }
  if (!event || event.isTrusted === false) return false;
  const target = event.target;
  if (target instanceof Element && isSidebarElement(target)) return false;
  return true;
}

function handleClick(event) {
  if (!shouldRecordEvent(event)) return;
  const target = event.target instanceof Element ? event.target : null;
  recordDomEvent('click', target, normaliseClickPayload(target, event));
}

function handleInput(event) {
  if (!shouldRecordEvent(event)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const now = Date.now();
  if (event.type === 'input') {
    const last = lastInputEvent.get(target) || 0;
    if (now - last < INPUT_EVENT_DEBOUNCE_MS) {
      return;
    }
    lastInputEvent.set(target, now);
  } else {
    lastInputEvent.set(target, now);
  }
  recordDomEvent('input', target, { ...normaliseInputPayload(target), trigger: event.type });
}

function handleSubmit(event) {
  if (!shouldRecordEvent(event)) return;
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  if (!form) return;
  recordDomEvent('submit', form, buildFormPayload(form));
}

function handleKeydown(event) {
  if (!shouldRecordEvent(event)) return;
  if (event.key !== 'Enter' && event.key !== 'Escape') return;
  const target = event.target instanceof Element ? event.target : null;
  recordDomEvent('key', target, {
    key: event.key,
    code: event.code,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
}

function bindDomListeners() {
  if (domListenersBound) return;
  domListenersBound = true;
  document.addEventListener('click', handleClick, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleInput, true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('keydown', handleKeydown, true);
  window.addEventListener('beforeunload', () => {
    domListenersBound = false;
  });
}

function applyAutomationProgress(payload) {
  const stepIndex = Number(payload.stepIndex);
  if (Number.isNaN(stepIndex) || stepIndex < 0) return;
  const status = (payload.status || 'pending').toLowerCase();
  const mapped =
    status === 'started'
      ? 'running'
      : status === 'completed'
        ? 'succeeded'
        : status;
  const steps = automationState.steps.slice();
  if (!steps[stepIndex]) {
    steps[stepIndex] = {
      index: stepIndex,
      title: `Step ${stepIndex + 1}`,
      status: 'pending',
      dom_selectors: [],
    };
  }
  steps[stepIndex] = { ...steps[stepIndex], status: mapped };
  const overallStatus = status === 'failed' ? 'failed' : status === 'completed' ? 'succeeded' : 'running';
  setAutomationState({ steps, status: overallStatus });
}

function handleAutomationMessage(kind, payload) {
  if (!payload || !payload.runId) return;
  if (!automationState.runId || automationState.runId !== payload.runId) {
    automationState = {
      ...automationState,
      runId: payload.runId,
    };
  }

  if (kind === 'automation_init') {
    events = [];
    rawEvents = [];
    setAutomationState({
      runId: payload.runId,
      automationId: payload.automationId || automationState.automationId,
      engine: (payload.engine || automationState.engine || '').toLowerCase() || null,
      status: (payload.status || 'running').toLowerCase(),
      name: payload.automationName || automationState.name,
      steps: payload.steps || [],
    });
    return;
  }

  if (kind === 'automation_progress') {
    applyAutomationProgress(payload);
    return;
  }

  if (kind === 'automation_complete') {
    const finalStatus = (payload.status || 'succeeded').toLowerCase();
    const steps = automationState.steps.map((step) => {
      if (finalStatus === 'succeeded' && step.status === 'running') {
        return { ...step, status: 'succeeded' };
      }
      return step;
    });
    setAutomationState({
      status: finalStatus,
      steps,
    });
  }
}

function handleEventsUpdated(newEvents) {
  rawEvents = Array.isArray(newEvents) ? newEvents : [];
  if (!sessionId) {
    events = rawEvents.slice();
  } else {
    events = rawEvents.filter((event) => !event.sessionId || event.sessionId === sessionId);
  }
  render();
}

function requestInitialEvents() {
  chrome.runtime.sendMessage({ type: 'modeler_get_events' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Modeler monitor unavailable', chrome.runtime.lastError.message);
      return;
    }
    handleEventsUpdated(response?.events || []);
  });
}

function forwardToBackground(kind, payload) {
  resolveSessionIdentity().then((id) => {
    if (!id) return;
    chrome.runtime.sendMessage(
      {
        type: 'modeler_event',
        sessionId: id,
        kind,
        payload,
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('Recorder monitor unavailable', chrome.runtime.lastError.message);
        }
      },
    );
  });
}

function handleWindowMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.source === 'modeler-dashboard' && data.type === 'modeler_session_created') {
    if (!data.sessionId) return;
    chrome.runtime.sendMessage(
      {
        type: 'modeler_session_config',
        sessionId: data.sessionId,
        config: {
          apiBase: data.apiBase,
          links: data.links,
          url: data.url,
        },
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('Unable to persist session config', chrome.runtime.lastError.message);
        }
      },
    );
    return;
  }

  if (data.source === 'modeler-dashboard' && data.type === 'modeler_run_preload') {
    if (!data.run || !data.run.run_id) return;
    chrome.runtime.sendMessage(
      {
        type: 'modeler_preload_run',
        apiBase: data.apiBase,
        run: data.run,
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('Unable to preload automation run', chrome.runtime.lastError.message);
        }
      },
    );
    return;
  }

  if (data.source !== 'modeler-demo' || data.type !== 'modeler_event') return;
  handleAutomationMessage(data.kind, data.payload);
  forwardToBackground(data.kind, data.payload);
}

function initialiseRecorder() {
  if (recorderInitialised) return;
  resolveSessionIdentity().then((id) => {
    if (!id) return;
    if (recorderInitialised) return;
    recorderInitialised = true;
    if (isDemoPage()) return;
    ensureSessionConfig().finally(() => {
      bindDomListeners();
      recordDomEvent('navigate', document.documentElement, {
        title: document.title,
        url: window.location.href,
      });
    });
  });
}

window.addEventListener('message', handleWindowMessage);

function initialiseApp() {
  if (appInitialised) return;
  appInitialised = true;
  onReady(() => {
    createSidebar();
    requestInitialEvents();
    initialiseRecorder();
    startAutomationRunIfNeeded();

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'modeler_events_updated') {
        handleEventsUpdated(message.events);
      }
    });

    window.addEventListener('beforeunload', () => {
      resetBodyOffset();
      window.removeEventListener('message', handleWindowMessage);
    });
  });
}

if (sessionId || automationState.runId) {
  initialiseApp();
} else {
  resolveSessionIdentity().then((id) => {
    if (id || automationState.runId) {
      initialiseApp();
    }
  });
}
