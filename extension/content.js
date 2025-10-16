const SIDEBAR_ID = 'modeler-recorder-sidebar';
const SIDEBAR_WIDTH = 340;
const SIDEBAR_COLLAPSED_WIDTH = 40;
const sessionParams = new URLSearchParams(window.location.search);
const sessionId = sessionParams.get('session');
let events = [];

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
