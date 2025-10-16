const SIDEBAR_ID = 'modeler-recorder-sidebar';
const SIDEBAR_WIDTH = 340;
const SIDEBAR_COLLAPSED_WIDTH = 40;
const sessionParams = new URLSearchParams(window.location.search);
const sessionId = sessionParams.get('session');
const automationRunParam = sessionParams.get('automation_run');
let events = [];
let automationState = {
  runId: automationRunParam || null,
  steps: [],
  status: 'idle',
  engine: (sessionParams.get('automation_engine') || '').toLowerCase() || null,
  automationId: sessionParams.get('automation_id') || null,
  name: 'Automation Run',
};

function onReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

function isRecordingPage() {
  return Boolean(sessionId);
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

  if (!events.length) {
    empty.style.display = 'block';
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
  return (Array.isArray(steps) ? steps : []).map((step, index) => ({
    ...step,
    index,
    status: (step?.status || 'pending').toLowerCase(),
  }));
}

function setAutomationState(partial) {
  const next = { ...automationState, ...partial };
  if (partial.steps !== undefined) {
    next.steps = normaliseAutomationSteps(partial.steps);
  }
  automationState = next;
  renderAutomation();
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
  const incoming = Array.isArray(newEvents) ? newEvents : [];
  events = incoming.filter((event) => !event.sessionId || event.sessionId === sessionId);
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
  if (!sessionId) return;
  chrome.runtime.sendMessage({
    type: 'modeler_event',
    sessionId,
    kind,
    payload,
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Recorder monitor unavailable', chrome.runtime.lastError.message);
    }
  });
}

function handleWindowMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'modeler-demo' || data.type !== 'modeler_event') return;
  handleAutomationMessage(data.kind, data.payload);
  forwardToBackground(data.kind, data.payload);
}

if (isRecordingPage()) {
  onReady(() => {
    createSidebar();
    requestInitialEvents();

    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'modeler_events_updated') {
        handleEventsUpdated(message.events);
      }
    });

    window.addEventListener('message', handleWindowMessage);

    window.addEventListener('beforeunload', () => {
      resetBodyOffset();
      window.removeEventListener('message', handleWindowMessage);
    });
  });
}
