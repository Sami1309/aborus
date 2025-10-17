const tabs = document.querySelectorAll('.tab-button');
const tabPanels = document.querySelectorAll('.tab');
const form = document.getElementById('record-form');
const urlInput = document.getElementById('record-url');
const feedbackCard = document.getElementById('record-feedback');
const sessionIdEl = document.getElementById('session-id');
const demoLink = document.getElementById('demo-link');
const targetLink = document.getElementById('recording-target-link');
const schemaLink = document.getElementById('schema-link');
const recordingLink = document.getElementById('recording-link');
const schemasList = document.getElementById('schemas-list');
const refreshButton = document.getElementById('refresh-sessions');
const flowchartSessionSelect = document.getElementById('flowchart-session');
const flowchartGenerateButton = document.getElementById('flowchart-generate');
const flowchartRefreshButton = document.getElementById('flowchart-refresh');
const flowchartStatus = document.getElementById('flowchart-status');
const flowchartStepsContainer = document.getElementById('flowchart-steps');
const flowchartDetail = document.getElementById('flowchart-detail');
const flowchartRawDetails = document.getElementById('flowchart-raw');
const flowchartRawBody = document.getElementById('flowchart-raw-body');
const automationForm = document.getElementById('automation-form');
const automationNameInput = document.getElementById('automation-name');
const automationEngineSelect = document.getElementById('automation-engine');
const automationNotesInput = document.getElementById('automation-notes');
const automationRunButton = document.getElementById('automation-run');
const automationList = document.getElementById('automation-list');
const refreshAutomationsButton = document.getElementById('refresh-automations');
const flowchartEditForm = document.getElementById('flowchart-edit-form');
const flowchartEditInput = document.getElementById('flowchart-edit-text');
const refreshRunsButton = document.getElementById('refresh-runs');
const runsList = document.getElementById('runs-list');
const automationSchemaModal = document.getElementById('automation-schema-modal');
const automationSchemaBody = document.getElementById('automation-schema-body');
const automationSchemaTitle = document.getElementById('automation-schema-title');

let cachedSessions = [];
let cachedAutomations = [];
let cachedRuns = [];
let currentFlowchart = null;
let selectedStepId = null;
let flowchartBusy = false;
let lastAutomationId = null;
let activeSchemaAutomationId = null;

function markSessionFlowchartReady(sessionId) {
  if (!sessionId) return;
  const session = cachedSessions.find((item) => item.session_id === sessionId);
  if (session) {
    session.flowchart_generated = true;
  }
  const option = flowchartSessionSelect?.querySelector(`option[value="${sessionId}"]`);
  if (option) {
    option.dataset.hasFlowchart = 'true';
  }
}

function switchTab(target) {
  tabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === target));
  tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${target}`));
}

tabs.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

async function fetchWithTimeout(url, options = {}) {
  const { timeout = 8000, ...rest } = options;
  const controller = rest.signal ? null : new AbortController();
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeout);
    rest.signal = controller.signal;
  }
  try {
    const response = await fetch(url, rest);
    return response;
  } catch (error) {
    if (controller && error.name === 'AbortError') {
      const timeoutError = new Error('Request timed out while contacting the server.');
      timeoutError.code = 'timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function setFlowchartRawSchema(payload) {
  if (!flowchartRawBody) return;
  if (payload === null) {
    flowchartRawBody.textContent = 'Select a recording to preview its schema.';
    return;
  }
  if (typeof payload === 'string') {
    flowchartRawBody.textContent = payload;
    return;
  }
  try {
    flowchartRawBody.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    flowchartRawBody.textContent = 'Unable to display schema JSON.';
  }
}

async function createSession(url) {
  const response = await fetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Unable to create session');
  }
  return response.json();
}

function notifyExtensionSession(session, links) {
  try {
    window.postMessage(
      {
        source: 'modeler-dashboard',
        type: 'modeler_session_created',
        sessionId: session?.session_id,
        url: session?.url,
        links,
        apiBase: window.location.origin,
      },
      window.location.origin,
    );
  } catch (error) {
    console.warn('Unable to notify extension about session', error);
  }
}

function renderFeedback(data, originalUrl) {
  const { session, links } = data;
  sessionIdEl.textContent = session.session_id;
  if (demoLink) demoLink.href = links.demo_page;
  if (schemaLink) schemaLink.href = links.schema;
  if (recordingLink) recordingLink.href = links.recording;
  const instrumentedTarget = links.recording_page || '';
  const effectiveTarget = instrumentedTarget || originalUrl || session.url;
  if (targetLink) {
    if (effectiveTarget) {
      targetLink.href = effectiveTarget;
      targetLink.parentElement?.removeAttribute('hidden');
    } else {
      targetLink.removeAttribute('href');
      targetLink.parentElement?.setAttribute('hidden', '');
    }
  }
  feedbackCard.hidden = false;

  const originalTarget = originalUrl || session.url;
  notifyExtensionSession(session, { ...links, recording_page: instrumentedTarget, original_url: originalTarget });

  const opened = new Set();
  if (effectiveTarget) {
    window.open(effectiveTarget, '_blank', 'noopener');
    opened.add(new URL(effectiveTarget, window.location.href).href);
  }
  if (links.demo_page) {
    const demoHref = new URL(links.demo_page, window.location.href).href;
    if (!opened.has(demoHref)) {
      window.open(links.demo_page, '_blank', 'noopener');
      opened.add(demoHref);
    }
  }
}

function formatDate(iso) {
  try {
    const date = new Date(iso);
    return date.toLocaleString();
  } catch (error) {
    return iso;
  }
}

function closeAutomationSchemaViewer() {
  if (!automationSchemaModal) return;
  automationSchemaModal.hidden = true;
  document.body.style.removeProperty('overflow');
  activeSchemaAutomationId = null;
}

function openAutomationSchemaViewer(automation) {
  if (!automationSchemaModal || !automationSchemaBody) return;
  const payload = {
    automation_id: automation.automation_id,
    name: automation.name || null,
    engine: automation.engine || null,
    description: automation.description || null,
    target_url: automation.target_url || null,
    steps: automation.steps || [],
    flowchart_snapshot: automation.flowchart_snapshot || null,
  };
  const title = automation.name || 'Automation schema';
  if (automationSchemaTitle) {
    automationSchemaTitle.textContent = title;
  }
  automationSchemaBody.textContent = JSON.stringify(payload, null, 2);
  automationSchemaModal.hidden = false;
  document.body.style.overflow = 'hidden';
  activeSchemaAutomationId = automation.automation_id;
}

async function viewAutomationSchemaById(automationId) {
  if (!automationId) return;
  let automation = cachedAutomations.find((item) => item.automation_id === automationId);
  if (!automation) {
    if (automationSchemaBody) {
      automationSchemaBody.textContent = 'Loading…';
    }
    if (automationSchemaModal && automationSchemaModal.hidden) {
      automationSchemaModal.hidden = false;
      document.body.style.overflow = 'hidden';
    }
    try {
      const response = await fetch(`/automations/${automationId}`);
      if (!response.ok) {
        throw new Error('Unable to load automation schema');
      }
      const data = await response.json();
      automation = data.automation || null;
    } catch (error) {
      console.error(error);
      if (automationSchemaBody) {
        automationSchemaBody.textContent = error.message || 'Failed to load automation schema.';
      }
      return;
    }
  }
  if (automation) {
    openAutomationSchemaViewer(automation);
  }
}

function renderSessions(list) {
  cachedSessions = Array.isArray(list) ? list : [];
  if (!cachedSessions.length) {
    schemasList.innerHTML = '<p class="muted">No sessions yet. Record a model to populate this list.</p>';
  } else {
    const fragments = cachedSessions
      .map((session) => {
        const links = session.links || {};
        return `
        <article class="schema-item">
          <h3>${session.url}</h3>
          <time>Created ${formatDate(session.created_at)}</time>
          <div class="schema-links">
            <a href="${links.schema}" target="_blank" rel="noopener">Schema</a>
            <a href="${links.recording}" target="_blank" rel="noopener">Raw recording</a>
            <a href="${links.demo_page}" target="_blank" rel="noopener">Demo page</a>
          </div>
        </article>
      `;
      })
      .join('');
    schemasList.innerHTML = fragments;
  }
  populateFlowchartSessions(cachedSessions);
}

function populateFlowchartSessions(list) {
  if (!flowchartSessionSelect) return;
  const previous = flowchartSessionSelect.value;
  flowchartSessionSelect.innerHTML = '<option value="">Select a session…</option>';
  list.forEach((session) => {
    const option = document.createElement('option');
    option.value = session.session_id;
    option.textContent = session.url;
    if (session.flowchart_generated) {
      option.dataset.hasFlowchart = 'true';
    }
    flowchartSessionSelect.appendChild(option);
  });
  if (previous && list.some((item) => item.session_id === previous)) {
    flowchartSessionSelect.value = previous;
  } else {
    flowchartSessionSelect.value = '';
    resetFlowchartView();
  }
}

function setFlowchartStatus(message, tone = 'muted') {
  if (!flowchartStatus) return;
  flowchartStatus.textContent = message;
  flowchartStatus.classList.remove('muted', 'error', 'success');
  flowchartStatus.classList.add(tone);
}

function setFlowchartBusy(state) {
  flowchartBusy = state;
  if (flowchartGenerateButton) flowchartGenerateButton.disabled = state;
  if (flowchartRefreshButton) flowchartRefreshButton.disabled = state;
  if (flowchartSessionSelect) flowchartSessionSelect.disabled = state;
  if (flowchartEditForm) {
    const controls = flowchartEditForm.querySelectorAll('textarea, button');
    controls.forEach((control) => {
      control.disabled = state;
    });
  }
}

function resetFlowchartView(options = {}) {
  const { clearRaw = true } = options;
  currentFlowchart = null;
  selectedStepId = null;
  if (flowchartStepsContainer) {
    flowchartStepsContainer.innerHTML = '<p class="muted">No flow chart yet.</p>';
  }
  if (flowchartDetail) {
    flowchartDetail.innerHTML = '<p class="muted">Select a step to inspect selectors, hints, and execution mode.</p>';
  }
  if (automationRunButton) {
    automationRunButton.disabled = true;
    automationRunButton.removeAttribute('data-automation-id');
  }
  if (flowchartEditForm) {
    flowchartEditForm.reset();
    const controls = flowchartEditForm.querySelectorAll('textarea, button');
    controls.forEach((control) => {
      control.disabled = false;
    });
  }
  if (clearRaw) {
    setFlowchartRawSchema(null);
  }
}

function normaliseStep(step, index) {
  const safeStep = step || {};
  const order = typeof safeStep.order === 'number' ? safeStep.order : index + 1;
  const title = safeStep.title || `Step ${order}`;
  const description = safeStep.description || safeStep.summary || title;
  return {
    node_id: safeStep.node_id || `node-${order}`,
    order,
    title,
    description,
    execution_mode: safeStep.execution_mode || 'deterministic',
    dom_selectors: Array.isArray(safeStep.dom_selectors) ? safeStep.dom_selectors : [],
    hints: safeStep.hints || {},
    source: safeStep.source || 'heuristic',
  };
}

function modeLabel(mode) {
  if (mode === 'llm') return 'LLM';
  if (mode === 'hybrid') return 'Hybrid';
  return 'Deterministic';
}

function renderFlowchart(chart) {
  if (!chart) {
    resetFlowchartView();
    return;
  }
  const steps = Array.isArray(chart.steps) ? chart.steps.map(normaliseStep) : [];
  currentFlowchart = { ...chart, steps };
  updateAutomationRunTarget(null);
  markSessionFlowchartReady(chart.session_id || flowchartSessionSelect?.value);
  renderFlowchartSteps(steps);
  if (steps.length) {
    selectFlowchartStep(steps[0].node_id);
    setFlowchartStatus('Flow chart ready.', 'success');
  } else {
    setFlowchartStatus('Claude did not return any steps.', 'error');
  }
}

function renderFlowchartSteps(steps) {
  if (!flowchartStepsContainer) return;
  if (!steps.length) {
    flowchartStepsContainer.innerHTML = '<p class="muted">Claude Sonnet has not produced any steps yet.</p>';
    return;
  }
  flowchartStepsContainer.innerHTML = '';
  steps.forEach((step) => {
    const item = document.createElement('article');
    item.className = 'flowchart-step';
    item.dataset.nodeId = step.node_id;
    item.dataset.mode = step.execution_mode || 'deterministic';

    const heading = document.createElement('h3');
    heading.textContent = step.title;
    item.appendChild(heading);

    const summary = document.createElement('p');
    summary.className = 'summary';
    summary.textContent = step.description;
    item.appendChild(summary);

    const badge = document.createElement('span');
    badge.className = 'mode-tag';
    badge.textContent = modeLabel(step.execution_mode);
    item.appendChild(badge);

    item.addEventListener('click', () => selectFlowchartStep(step.node_id));
    flowchartStepsContainer.appendChild(item);
  });
}

function selectFlowchartStep(nodeId) {
  if (!currentFlowchart) return;
  selectedStepId = nodeId;
  const step = currentFlowchart.steps.find((s) => s.node_id === nodeId);
  const stepCards = flowchartStepsContainer?.querySelectorAll('.flowchart-step') || [];
  stepCards.forEach((card) => {
    card.classList.toggle('active', card.dataset.nodeId === nodeId);
  });
  if (step) {
    renderStepDetail(step);
  }
}

function updateStepCardMode(step) {
  if (!flowchartStepsContainer) return;
  const card = flowchartStepsContainer.querySelector(`.flowchart-step[data-node-id="${step.node_id}"]`);
  if (card) {
    card.dataset.mode = step.execution_mode;
    const badge = card.querySelector('.mode-tag');
    if (badge) {
      badge.textContent = modeLabel(step.execution_mode);
    }
  }
}

function renderStepDetail(step) {
  if (!flowchartDetail) return;
  flowchartDetail.innerHTML = '';

  const title = document.createElement('h3');
  title.textContent = step.title;
  flowchartDetail.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.className = 'muted';
  subtitle.textContent = step.description;
  flowchartDetail.appendChild(subtitle);

  const orderHint = document.createElement('p');
  orderHint.className = 'muted';
  orderHint.textContent = `Order: ${step.order}`;
  flowchartDetail.appendChild(orderHint);

  const modeLabelEl = document.createElement('label');
  modeLabelEl.textContent = 'Execution mode';
  flowchartDetail.appendChild(modeLabelEl);

  const modeSelect = document.createElement('select');
  ['deterministic', 'llm', 'hybrid'].forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent =
      value === 'llm'
        ? 'LLM (Claude browser/computer use)'
        : value === 'hybrid'
          ? 'Hybrid (mix selectors + LLM)'
          : 'Deterministic (selectors)';
    if (value === (step.execution_mode || 'deterministic')) {
      option.selected = true;
    }
    modeSelect.appendChild(option);
  });
  modeSelect.addEventListener('change', () => {
    step.execution_mode = modeSelect.value;
    updateStepCardMode(step);
  });
  flowchartDetail.appendChild(modeSelect);

  const selectorsBlock = document.createElement('div');
  selectorsBlock.className = 'detail-block';
  const selectorsHeading = document.createElement('h4');
  selectorsHeading.textContent = 'DOM selectors';
  selectorsBlock.appendChild(selectorsHeading);
  const selectorsList = document.createElement('div');
  selectorsList.className = 'selectors';
  if (Array.isArray(step.dom_selectors) && step.dom_selectors.length) {
    step.dom_selectors.forEach((selector) => {
      const code = document.createElement('code');
      code.textContent = selector;
      selectorsList.appendChild(code);
    });
  } else {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No selectors captured. Prefer LLM execution or add selectors manually.';
    selectorsList.appendChild(empty);
  }
  selectorsBlock.appendChild(selectorsList);
  flowchartDetail.appendChild(selectorsBlock);

  const hintsBlock = document.createElement('div');
  hintsBlock.className = 'detail-block';
  const hintsHeading = document.createElement('h4');
  hintsHeading.textContent = 'LLM hints';
  hintsBlock.appendChild(hintsHeading);
  const hintsEntries = Object.entries(step.hints || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (hintsEntries.length) {
    const list = document.createElement('ul');
    list.className = 'hint-list';
    hintsEntries.forEach(([key, value]) => {
      const item = document.createElement('li');
      item.textContent = `${key}: ${value}`;
      list.appendChild(item);
    });
    hintsBlock.appendChild(list);
  } else {
    const emptyHint = document.createElement('p');
    emptyHint.className = 'muted';
    emptyHint.textContent = 'No extra hints available for this step.';
    hintsBlock.appendChild(emptyHint);
  }
  flowchartDetail.appendChild(hintsBlock);
}

async function loadSessions() {
  try {
    const response = await fetch('/sessions');
    if (!response.ok) {
      throw new Error('Failed to fetch sessions');
    }
    const data = await response.json();
    renderSessions(data.sessions || []);
  } catch (error) {
    console.error(error);
    schemasList.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

async function fetchSchema(sessionId) {
  const response = await fetchWithTimeout(`/sessions/${sessionId}/schema`, { timeout: 8000 });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Unable to load schema');
  }
  return response.json();
}

async function fetchFlowchart(sessionId) {
  let response;
  try {
    response = await fetchWithTimeout(`/sessions/${sessionId}/flowchart`, { timeout: 6000 });
  } catch (error) {
    if (error.code === 'timeout') {
      error.status = 504;
    }
    throw error;
  }
  if (response.status === 404) {
    const error = new Error('No flow chart yet. Ask Claude to generate one.');
    error.status = 404;
    throw error;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Unable to load flow chart');
  }
  return response.json();
}

async function generateFlowchartForSession(sessionId, { regenerate = false } = {}) {
  const response = await fetch(`/sessions/${sessionId}/flowchart`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerate }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to generate flow chart');
  }
  return response.json();
}

async function loadFlowchartForSession(sessionId, { autoGenerate = false } = {}) {
  if (!sessionId) {
    resetFlowchartView();
    setFlowchartStatus('Pick a recorded session to build a flow chart.', 'muted');
    return;
  }

  setFlowchartBusy(true);
  resetFlowchartView({ clearRaw: false });
  setFlowchartStatus('Loading session schema…', 'muted');
  setFlowchartRawSchema('Loading schema…');

  try {
    const schema = await fetchSchema(sessionId);
    setFlowchartRawSchema(schema);
  } catch (schemaError) {
    console.error('Failed to load schema for flowchart view', schemaError);
    const message = schemaError?.message || 'Unable to load schema';
    setFlowchartRawSchema(`Error loading schema: ${message}`);
  }

  setFlowchartStatus('Checking for Claude flow chart…', 'muted');

  try {
    const chart = await fetchFlowchart(sessionId);
    renderFlowchart(chart);
  } catch (error) {
    if (error.status === 404) {
      setFlowchartStatus('Raw schema ready. Ask Claude to generate a flow chart.', 'muted');
      if (autoGenerate) {
        try {
          setFlowchartStatus('Generating fresh flow chart with Claude Sonnet 4.5…');
          const regenerated = await generateFlowchartForSession(sessionId, { regenerate: true });
          renderFlowchart(regenerated);
        } catch (innerError) {
          setFlowchartStatus(innerError.message || 'Unable to generate flow chart', 'error');
        }
      }
    } else if (error.code === 'timeout' || error.status === 504) {
      setFlowchartStatus('Timed out while loading flow chart. Try again or generate with Claude.', 'error');
    } else {
      setFlowchartStatus(error.message || 'Unable to load flow chart', 'error');
    }
  } finally {
    setFlowchartBusy(false);
  }
}

function renderAutomations(list) {
  if (!automationList) return;
  cachedAutomations = Array.isArray(list) ? list : [];
  if (!cachedAutomations.length) {
    automationList.innerHTML = '<p class="muted">No automations yet. Generate a flow chart and save one.</p>';
    return;
  }
  const items = cachedAutomations
    .map((automation) => {
      const updated = formatDate(automation.updated_at || automation.created_at);
      const engine = modeLabel(automation.engine || 'deterministic');
      const stepsCount = Array.isArray(automation.steps) ? automation.steps.length : 0;
      const latestBadge = automation.automation_id === lastAutomationId ? '<span class="run-status pending">latest</span>' : '';
      const target = automation.target_url || 'Not captured';
      return `
        <article class="schema-item automation-card" data-automation-id="${automation.automation_id}">
          <div class="automation-card-header">
            <h3>${automation.name || 'Automation'}</h3>
            <div class="automation-card-actions">
              ${latestBadge}
              <button type="button" class="automation-schema-trigger" data-automation-id="${automation.automation_id}">Schema</button>
              <button type="button" class="automation-run-trigger" data-automation-id="${automation.automation_id}" data-engine="${automation.engine || 'deterministic'}">Run</button>
            </div>
          </div>
          <time>Updated ${updated}</time>
          <p class="automation-meta">Engine: ${engine} · Steps: ${stepsCount}</p>
          <p class="automation-meta">Target: ${target}</p>
        </article>
      `;
    })
    .join('');
  automationList.innerHTML = items;
}

function automationNameById(automationId) {
  const match = cachedAutomations.find((item) => item.automation_id === automationId);
  if (!match) return automationId;
  return match.name || automationId;
}

function renderRuns(list) {
  if (!runsList) return;
  cachedRuns = Array.isArray(list) ? list : [];
  if (!cachedRuns.length) {
    runsList.innerHTML = '<p class="muted">No automation runs yet. Run an automation to see history.</p>';
    return;
  }
  const items = cachedRuns
    .map((run) => {
      const statusValue = (run.status || 'pending').toLowerCase();
      const statusClass = statusValue === 'succeeded' ? 'succeeded' : statusValue === 'failed' ? 'failed' : 'pending';
      const statusLabel = statusValue.charAt(0).toUpperCase() + statusValue.slice(1);
      const timestamp = formatDate(run.completed_at || run.started_at || run.created_at);
      const engineLabel = modeLabel(run.engine || 'deterministic');
      const planned = typeof run.steps_planned === 'number' ? run.steps_planned : run.steps_executed;
      const executed = typeof run.steps_executed === 'number' ? run.steps_executed : 0;
      const stepsSummary = planned !== undefined ? `Steps ${executed}/${planned}` : `Steps ${executed}`;
      const message = run.message || (run.result && run.result.summary) || 'Run updated.';
      const automationLabel = automationNameById(run.automation_id);
      return `
        <article class="schema-item run-item" data-run-id="${run.run_id}">
          <div class="schema-item-body">
            <div class="automation-card-header">
              <h3>${automationLabel}</h3>
              <span class="run-status ${statusClass}">${statusLabel}</span>
            </div>
            <time>${timestamp}</time>
            <p class="run-meta">Engine: ${engineLabel} · ${stepsSummary}</p>
            <p class="run-message">${message}</p>
          </div>
        </article>
      `;
    })
    .join('');
  runsList.innerHTML = items;
}

async function loadAutomations() {
  if (!automationList) return;
  try {
    const response = await fetch('/automations');
    if (!response.ok) {
      throw new Error('Failed to load automations');
    }
    const data = await response.json();
    renderAutomations(data.automations || []);
  } catch (error) {
    automationList.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

async function loadRuns() {
  if (!runsList) return;
  try {
    const response = await fetch('/runs');
    if (!response.ok) {
      throw new Error('Failed to load automation runs');
    }
    const data = await response.json();
    renderRuns(data.runs || []);
  } catch (error) {
    runsList.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

async function queueAutomationRun(automationId, { engine } = {}) {
  if (!automationId) {
    throw new Error('Automation id missing');
  }
  const payload = engine ? { engine } : {};
  const response = await fetch(`/automations/${automationId}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Failed to queue automation run');
  }
  const data = await response.json();
  try {
    await loadRuns();
  } catch (error) {
    console.error('Failed to refresh runs after starting automation', error);
  }
  if (data.launch_url) {
    try {
      window.open(data.launch_url, '_blank', 'noopener');
    } catch (error) {
      console.warn('Unable to open automation launch URL', error);
    }
  }
  return data;
}

function updateAutomationRunTarget(automationId) {
  if (!automationRunButton) return;
  if (automationId) {
    automationRunButton.disabled = false;
    automationRunButton.dataset.automationId = automationId;
  } else {
    automationRunButton.disabled = true;
    automationRunButton.removeAttribute('data-automation-id');
  }
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  try {
    const data = await createSession(url);
    renderFeedback(data, url);
    await loadSessions();
  } catch (error) {
    feedbackCard.hidden = false;
    feedbackCard.classList.remove('muted');
    feedbackCard.innerHTML = `<h2>Something went wrong</h2><p>${error.message}</p>`;
  }
});

refreshButton?.addEventListener('click', loadSessions);

flowchartSessionSelect?.addEventListener('change', (event) => {
  const sessionId = event.target.value;
  loadFlowchartForSession(sessionId, { autoGenerate: false });
});

flowchartGenerateButton?.addEventListener('click', async () => {
  const sessionId = flowchartSessionSelect?.value;
  if (!sessionId || flowchartBusy) {
    setFlowchartStatus('Select a recording before asking Claude to generate.', 'error');
    return;
  }
  setFlowchartBusy(true);
  setFlowchartStatus('Generating flow chart with Claude Sonnet 4.5…');
  try {
    const chart = await generateFlowchartForSession(sessionId, { regenerate: true });
    renderFlowchart(chart);
    setFlowchartStatus('Flow chart generated with Claude Sonnet 4.5.', 'success');
  } catch (error) {
    setFlowchartStatus(error.message || 'Failed to generate flow chart', 'error');
  } finally {
    setFlowchartBusy(false);
  }
});

flowchartRefreshButton?.addEventListener('click', () => {
  const sessionId = flowchartSessionSelect?.value;
  if (!sessionId) {
    setFlowchartStatus('Select a recording to refresh its flow chart.', 'muted');
    return;
  }
  loadFlowchartForSession(sessionId, { autoGenerate: false });
});

flowchartEditForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const sessionId = flowchartSessionSelect?.value;
  if (!sessionId) {
    setFlowchartStatus('Select a recording before editing the flow.', 'error');
    return;
  }
  const instructions = flowchartEditInput?.value.trim();
  if (!instructions) {
    setFlowchartStatus('Describe the change you need before applying it.', 'error');
    if (flowchartEditInput) flowchartEditInput.focus();
    return;
  }
  setFlowchartBusy(true);
  setFlowchartStatus('Updating flow chart with Claude Sonnet 4.5…');
  try {
    const response = await fetch(`/sessions/${sessionId}/flowchart/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Failed to update flow chart');
    }
    const chart = await response.json();
    renderFlowchart(chart);
    setFlowchartStatus('Flow chart updated with Claude Sonnet 4.5.', 'success');
    flowchartEditForm.reset();
  } catch (error) {
    setFlowchartStatus(error.message || 'Unable to update flow chart', 'error');
  } finally {
    setFlowchartBusy(false);
  }
});

automationForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentFlowchart) {
    setFlowchartStatus('Generate a flow chart before saving an automation.', 'error');
    return;
  }
  const name = automationNameInput.value.trim();
  if (!name) {
    setFlowchartStatus('Give your automation a name first.', 'error');
    return;
  }
  const payload = {
    session_id: currentFlowchart.session_id,
    name,
    engine: automationEngineSelect.value,
    description: automationNotesInput.value.trim() || null,
    steps: currentFlowchart.steps.map((step) => ({
      node_id: step.node_id,
      execution_mode: step.execution_mode || 'deterministic',
      dom_selectors: step.dom_selectors || [],
      title: step.title,
      description: step.description,
      hints: step.hints || {},
      order: step.order,
    })),
    flowchart_snapshot: currentFlowchart,
  };
  try {
    const response = await fetch('/automations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Unable to save automation');
    }
    const data = await response.json();
    const automationId = data.automation?.automation_id;
    lastAutomationId = automationId || lastAutomationId;
    updateAutomationRunTarget(automationId);
    setFlowchartStatus('Automation saved. Ready to run.', 'success');
    automationForm.reset();
    automationEngineSelect.value = payload.engine;
    await loadAutomations();
  } catch (error) {
    setFlowchartStatus(error.message || 'Failed to save automation', 'error');
  }
});

automationRunButton?.addEventListener('click', async () => {
  const automationId = automationRunButton.dataset.automationId;
  if (!automationId) {
    setFlowchartStatus('Save an automation before running it.', 'error');
    return;
  }
  automationRunButton.disabled = true;
  try {
    const run = await queueAutomationRun(automationId, { engine: automationEngineSelect.value });
    const statusValue = (run.status || 'queued').toLowerCase();
    if (statusValue === 'succeeded') {
      setFlowchartStatus(`Automation completed (${modeLabel(run.engine)}).`, 'success');
    } else if (statusValue === 'running') {
      setFlowchartStatus('Automation running in new tab. Monitor progress via the recorder sidebar.', 'muted');
    } else if (statusValue === 'failed') {
      const message = run.message || 'Automation reported a failure.';
      setFlowchartStatus(message, 'error');
    } else {
      setFlowchartStatus(`Automation run ${statusValue}.`, 'muted');
    }
    await loadAutomations();
  } catch (error) {
    setFlowchartStatus(error.message || 'Unable to queue automation', 'error');
  } finally {
    automationRunButton.disabled = false;
  }
});

automationList?.addEventListener('click', async (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;

  const schemaTrigger = target.closest('.automation-schema-trigger');
  if (schemaTrigger) {
    const automationId = schemaTrigger.dataset.automationId;
    if (!automationId) return;
    schemaTrigger.disabled = true;
    try {
      await viewAutomationSchemaById(automationId);
    } finally {
      schemaTrigger.disabled = false;
    }
    return;
  }

  const trigger = target.closest('.automation-run-trigger');
  if (!trigger) return;
  const automationId = trigger.dataset.automationId;
  if (!automationId) return;
  const engine = trigger.dataset.engine;
  const originalText = trigger.textContent || 'Run';
  trigger.disabled = true;
  trigger.textContent = 'Running…';
  try {
    const run = await queueAutomationRun(automationId, { engine });
    const statusValue = (run.status || 'succeeded').toLowerCase();
    if (statusValue === 'running') {
      trigger.textContent = 'Running…';
    } else if (statusValue === 'succeeded') {
      trigger.textContent = 'Ran ✓';
    } else {
      trigger.textContent = `Run (${statusValue})`;
    }
    setTimeout(() => {
      trigger.textContent = originalText;
      trigger.disabled = false;
      loadAutomations();
    }, 1600);
  } catch (error) {
    console.error('Unable to start automation run', error);
    trigger.textContent = 'Retry';
    setTimeout(() => {
      trigger.textContent = originalText;
      trigger.disabled = false;
    }, 1800);
  }
});

document.addEventListener('click', (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target) return;
  const dismiss = target.closest('[data-modal-dismiss]');
  if (dismiss && dismiss.dataset.modalDismiss === 'automation-schema-modal') {
    closeAutomationSchemaViewer();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && automationSchemaModal && !automationSchemaModal.hidden) {
    closeAutomationSchemaViewer();
  }
});

refreshRunsButton?.addEventListener('click', loadRuns);
refreshAutomationsButton?.addEventListener('click', loadAutomations);

// Initialise form with demo page for convenience
if (urlInput && !urlInput.value) {
  urlInput.value = `${window.location.origin}/web/test-page.html`;
}

loadSessions();
loadAutomations();
loadRuns();
