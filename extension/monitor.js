async function loadEvents() {
  const { modeler_events: events = [] } = await chrome.storage.local.get('modeler_events');
  render(events);
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
      sessionId: event.sessionId,
      time,
      extra: selectors.length ? `Selector guess: ${selectors.join(', ')}` : null,
    };
  }

  const payload = event?.payload || {};
  const detailSource = payload.payload || payload;
  const detail = JSON.stringify(detailSource, null, 0);
  const type = payload.category || payload.type || 'event';
  return {
    type,
    detail,
    sessionId: event.sessionId,
    time,
    extra: payload.dom ? `Target: ${payload.dom.tag}${payload.dom.attributes?.id ? `#${payload.dom.attributes.id}` : ''}` : null,
  };
}

function render(events) {
  const list = document.getElementById('events');
  const empty = document.getElementById('empty-state');
  if (!events.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = events
    .map((evt) => {
      const formatted = formatEvent(evt);
      const extra = formatted.extra ? `<div class="extra">${formatted.extra}</div>` : '';
      return `
        <li>
          <div class="type">${formatted.type} <span class="session">(${formatted.sessionId})</span></div>
          <div class="detail">${formatted.detail}</div>
          ${extra}
          <time>${formatted.time}</time>
        </li>
      `;
    })
    .join('');
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'modeler_events_updated') {
    render(message.events || []);
  }
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ modeler_events: [] });
  render([]);
});

loadEvents();
