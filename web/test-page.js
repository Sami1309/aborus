const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session');
const automationRunId = params.get('automation_run');
const automationId = params.get('automation_id');
const automationEngine = (params.get('automation_engine') || 'deterministic').toLowerCase();
const logContainer = document.getElementById('event-log');
const template = document.getElementById('event-template');
const itemForm = document.getElementById('item-form');
const itemsList = document.getElementById('items');
const buttons = document.querySelectorAll('button[data-action]');
const inputFields = document.querySelectorAll('#item-input, #item-quantity');
const STEP_DELAY_MS = 600;

if (!sessionId) {
  const warning = document.createElement('p');
  warning.textContent = 'No session id provided. Append ?session=<id> to enable recording.';
  warning.style.color = '#fb7185';
  if (logContainer) {
    logContainer.replaceWith(warning);
  }
}

function uuid() {
  return `evt-${Math.random().toString(16).slice(2)}-${Date.now()}`;
}

function computeCssPath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
  const path = [];
  let el = element;
  while (el && el.nodeType === Node.ELEMENT_NODE && path.length < 6) {
    let selector = el.nodeName.toLowerCase();
    if (el.id) {
      selector += `#${el.id}`;
      path.unshift(selector);
      break;
    }
    if (el.classList.length) {
      selector += `.${Array.from(el.classList).slice(0, 2).join('.')}`;
    }
    const siblingIndex = Array.from(el.parentNode ? el.parentNode.children : []).indexOf(el);
    if (siblingIndex > 0) {
      selector += `:nth-child(${siblingIndex + 1})`;
    }
    path.unshift(selector);
    el = el.parentElement;
  }
  return path.join(' > ');
}

function buildDomSnapshot(element) {
  if (!(element instanceof HTMLElement)) return null;
  const attributes = {};
  if (element.id) attributes.id = element.id;
  if (element.getAttribute('role')) attributes.role = element.getAttribute('role');
  if (element.getAttribute('type')) attributes.type = element.getAttribute('type');
  if (element.hasAttribute('data-action')) {
    attributes['data-action'] = element.getAttribute('data-action');
  }
  const name =
    element.getAttribute('aria-label') ||
    element.textContent?.trim() ||
    element.innerText?.trim() ||
    null;
  return {
    tag: element.tagName.toLowerCase(),
    attributes,
    accessibleName: name,
    innerText: element.innerText,
    classList: Array.from(element.classList || []),
    cssPath: computeCssPath(element),
  };
}

function logEventCard(type, detail, error) {
  if (!template || !logContainer) return;
  const clone = template.content.firstElementChild.cloneNode(true);
  clone.querySelector('.event-type').textContent = type;
  clone.querySelector('.event-detail').textContent =
    typeof detail === 'string' ? detail : JSON.stringify(detail);
  clone.querySelector('.event-time').textContent = new Date().toLocaleTimeString();
  if (error) {
    clone.style.border = '1px solid #fb7185';
    clone.querySelector('.event-type').textContent += ' (failed)';
  }
  logContainer.prepend(clone);
  while (logContainer.children.length > 20) {
    logContainer.lastChild.remove();
  }
}

function logIntent(node) {
  if (!node || !node.intent) return;
  const summary = node.intent.summary || 'No summary provided';
  const selector = Array.isArray(node.selectors) && node.selectors.length ? `Selector: ${node.selectors[0]}` : '';
  const detail = selector ? `${summary} (${selector})` : summary;
  logEventCard('intent', detail, false);
}

function notifyExtension(kind, payload) {
  window.postMessage({
    source: 'modeler-demo',
    type: 'modeler_event',
    kind,
    sessionId,
    payload,
  });
}

function notifyAutomation(kind, payload) {
  if (!automationRunId) return;
  notifyExtension(kind, {
    runId: automationRunId,
    automationId,
    engine: automationEngine,
    ...(payload || {}),
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEvent(category, element, payload) {
  if (!sessionId) return;
  const dom = buildDomSnapshot(element);
  const body = {
    event_id: uuid(),
    timestamp: new Date().toISOString(),
    category,
    url: window.location.href,
    dom,
    payload,
  };
  notifyExtension('raw', body);
  try {
    const response = await fetch(`/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: body }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result && result.node) {
      notifyExtension('summary', result.node);
      logIntent(result.node);
    }
    logEventCard(category, payload, false);
  } catch (error) {
    logEventCard(category, error.message, true);
    console.error('Failed to record event', error);
  }
}

if (sessionId) {
  buttons.forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.action || 'unknown';
      if (action === 'reset') {
        itemForm.reset();
        itemsList.innerHTML = '';
      }
      if (action === 'help') {
        alert('Try adding an item, then checking out to see the flow diagram.');
      }
      sendEvent('click', button, { action });
    });
  });

  inputFields.forEach((input) => {
    input.addEventListener('change', () => {
      sendEvent('input', input, { name: input.name, value: input.value });
    });
  });

  itemForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const formData = new FormData(itemForm);
    const item = formData.get('item');
    const quantity = formData.get('quantity');
    if (item) {
      const li = document.createElement('li');
      li.textContent = `${quantity} × ${item}`;
      itemsList.append(li);
    }
    sendEvent('submit', itemForm, { item, quantity });
    itemForm.reset();
  });
}

async function reportRunProgress(stepIndex, status, message, details) {
  if (!automationRunId) return;
  try {
    const response = await fetch(`/runs/${automationRunId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        step_index: stepIndex,
        status,
        message,
        details,
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('Unable to report automation progress', error);
  }
}

function highlightElement(element) {
  if (!(element instanceof HTMLElement)) return () => {};
  element.classList.add('automation-highlight');
  return () => {
    element.classList.remove('automation-highlight');
  };
}

function readStepValue(step) {
  const hints = step?.hints || {};
  return hints.user_value ?? hints.value ?? hints.text ?? hints.input ?? '';
}

async function performStepAction(step) {
  const selectors = step?.dom_selectors || step?.selectors || [];
  const selector = selectors.find((item) => typeof item === 'string' && item.trim().length > 0);
  if (!selector) {
    return { outcome: 'skipped', message: 'No selectors available for step.' };
  }
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Selector not found: ${selector}`);
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
      if (value) {
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
      element.focus();
      element.click();
    }
    await delay(200);
    return {
      outcome: 'succeeded',
      message: `Executed step via ${selector} (${mode}).`,
      selector,
    };
  } finally {
    cleanup();
  }
}

async function executeAutomationStep(step, index) {
  const title = step?.title || `Step ${index + 1}`;
  const description = step?.description || title;
  notifyAutomation('automation_progress', {
    stepIndex: index,
    status: 'started',
    step,
  });
  logEventCard('automation', `${title}: starting`, false);
  await reportRunProgress(index, 'started', `Starting ${title}`, { description });
  await delay(STEP_DELAY_MS);

  try {
    if ((step.execution_mode || '').toLowerCase() === 'llm') {
      await reportRunProgress(index, 'succeeded', `${title} delegated to LLM.`, { execution_mode: 'llm' });
      notifyAutomation('automation_progress', {
        stepIndex: index,
        status: 'succeeded',
        step,
        delegated: true,
      });
      logEventCard('automation', `${title}: delegated to LLM`, false);
      return;
    }

    const result = await performStepAction(step);
    const outcomeStatus = result.outcome === 'skipped' ? 'skipped' : 'succeeded';
    await reportRunProgress(index, outcomeStatus, result.message, { selector: result.selector });
    notifyAutomation('automation_progress', {
      stepIndex: index,
      status: outcomeStatus,
      step,
    });
    logEventCard('automation', `${title}: ${outcomeStatus}`, outcomeStatus === 'failed');
  } catch (error) {
    await reportRunProgress(index, 'failed', `${title} failed: ${error.message}`, { error: error.message });
    notifyAutomation('automation_progress', {
      stepIndex: index,
      status: 'failed',
      step,
      error: error.message,
    });
    logEventCard('automation', `${title}: failed`, true);
    throw error;
  }
}

async function startAutomationRun() {
  if (!automationRunId) return;
  try {
    const response = await fetch(`/runs/${automationRunId}`);
    if (!response.ok) {
      throw new Error(`Run ${automationRunId} not found`);
    }
    const data = await response.json();
    const run = data.run || data;
    const steps = Array.isArray(run.steps) ? run.steps : [];
    notifyAutomation('automation_init', {
      steps,
      status: run.status,
      automationName: run.automation_name || run.name || 'Automation run',
    });

    for (let index = 0; index < steps.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await executeAutomationStep(steps[index], index);
    }

    if (steps.length) {
      await reportRunProgress(steps.length - 1, 'completed', 'Automation completed', {});
    }
    notifyAutomation('automation_complete', { status: 'succeeded' });
    logEventCard('automation', 'Automation completed', false);
  } catch (error) {
    console.error('Automation run failed', error);
    const failingStep = 0;
    await reportRunProgress(failingStep, 'failed', error.message, { reason: error.message });
    notifyAutomation('automation_complete', { status: 'failed', message: error.message });
    logEventCard('automation', `Automation failed: ${error.message}`, true);
  }
}

if (automationRunId) {
  startAutomationRun();
}
