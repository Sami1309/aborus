const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session');
const logContainer = document.getElementById('event-log');
const template = document.getElementById('event-template');
const itemForm = document.getElementById('item-form');
const itemsList = document.getElementById('items');
const buttons = document.querySelectorAll('button[data-action]');
const inputFields = document.querySelectorAll('#item-input, #item-quantity');

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
