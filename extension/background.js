const MAX_EVENTS = 50;
const SESSION_CONFIG_KEY = 'modeler_session_configs';
let monitorWindowId = null;
let sessionConfigsCache = null;

function normaliseApiBase(apiBase) {
  return typeof apiBase === 'string' ? apiBase.replace(/\/+$/, '') : '';
}

async function fetchRunRecord(runId, apiBase) {
  if (!runId) {
    throw new Error('Missing runId');
  }
  const base = normaliseApiBase(apiBase);
  if (!base) {
    throw new Error('Missing API base for run lookup');
  }
  const response = await fetch(`${base}/runs/${runId}`);
  if (!response.ok) {
    const detail = await response.text();
    const message = detail || `HTTP ${response.status}`;
    throw new Error(message);
  }
  const data = await response.json();
  return data.run || data;
}

async function postRunProgress(runId, apiBase, payload) {
  if (!runId) {
    throw new Error('Missing runId');
  }
  const base = normaliseApiBase(apiBase);
  if (!base) {
    throw new Error('Missing API base for run progress');
  }
  const response = await fetch(`${base}/runs/${runId}/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text();
    const message = detail || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json();
}

async function getSessionConfigs() {
  if (sessionConfigsCache) {
    return sessionConfigsCache;
  }
  const stored = await chrome.storage.local.get(SESSION_CONFIG_KEY);
  const configs = stored?.[SESSION_CONFIG_KEY] || {};
  sessionConfigsCache = configs;
  return configs;
}

async function persistSessionConfigs(configs) {
  sessionConfigsCache = configs;
  await chrome.storage.local.set({ [SESSION_CONFIG_KEY]: configs });
}

async function upsertSessionConfig(sessionId, config) {
  if (!sessionId) return;
  const configs = await getSessionConfigs();
  const existing = configs[sessionId] || {};
  const merged = {
    ...existing,
    ...config,
    updated_at: new Date().toISOString(),
  };
  configs[sessionId] = merged;
  await persistSessionConfigs(configs);
  return merged;
}

async function getSessionConfig(sessionId) {
  const configs = await getSessionConfigs();
  return configs[sessionId] || null;
}

async function recordSessionEvent(sessionId, event, apiBaseHint) {
  if (!sessionId) {
    throw new Error('Missing sessionId for record event');
  }
  if (!event) {
    throw new Error('Missing event payload');
  }
  const storedConfig = await getSessionConfig(sessionId);
  const apiBase = (apiBaseHint || storedConfig?.apiBase || '').replace(/\/+$/, '');
  if (!apiBase) {
    throw new Error(`No API base available for session ${sessionId}`);
  }
  const endpoint = `${apiBase}/sessions/${sessionId}/events`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: event }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return response.json();
}

async function getStoredEvents() {
  const stored = await chrome.storage.local.get('modeler_events');
  return stored.modeler_events || [];
}

async function appendEvent(event) {
  const events = await getStoredEvents();
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  await chrome.storage.local.set({ modeler_events: events });

  const broadcastPayload = { type: 'modeler_events_updated', events };
  try {
    await chrome.runtime.sendMessage(broadcastPayload);
  } catch (error) {
    // No extension pages listening
  }

  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      let sessionId;
      try {
        const url = new URL(tab.url);
        sessionId = url.searchParams.get('session');
      } catch (error) {
        sessionId = undefined;
      }
      if (!sessionId) continue;
      const sessionEvents = events.filter((item) => item.sessionId === sessionId);
      if (!sessionEvents.length) continue;
      try {
        chrome.tabs.sendMessage(tab.id, {
          type: 'modeler_events_updated',
          events: sessionEvents,
        });
      } catch (error) {
        // Tab might not have the content script injected (e.g., permissions)
      }
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'modeler_event') {
    const event = {
      sessionId: message.sessionId,
      kind: message.kind || 'raw',
      payload: message.payload,
      receivedAt: new Date().toISOString(),
      origin: sender?.url || null,
    };
    appendEvent(event);
    sendResponse({ ok: true });
  } else if (message.type === 'modeler_get_events') {
    getStoredEvents().then((events) => {
      sendResponse({ events });
    });
    return true;
  } else if (message.type === 'modeler_session_config') {
    const { sessionId, config } = message;
    upsertSessionConfig(sessionId, config)
      .then((stored) => {
        sendResponse({ ok: true, config: stored });
      })
      .catch((error) => {
        console.error('Failed to persist session config', error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  } else if (message.type === 'modeler_get_session_config') {
    const { sessionId } = message;
    getSessionConfig(sessionId)
      .then((config) => {
        sendResponse({ config });
      })
      .catch((error) => {
        console.error('Failed to load session config', error);
        sendResponse({ config: null, error: error.message });
      });
    return true;
  } else if (message.type === 'modeler_record_event') {
    const { sessionId, event, apiBase } = message;
    recordSessionEvent(sessionId, event, apiBase)
      .then((result) => {
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => {
        console.error('Failed to record session event', error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  } else if (message.type === 'modeler_fetch_run') {
    const { runId, apiBase } = message;
    fetchRunRecord(runId, apiBase)
      .then((run) => {
        sendResponse({ ok: true, run });
      })
      .catch((error) => {
        console.error('Failed to fetch automation run', error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  } else if (message.type === 'modeler_run_progress') {
    const { runId, apiBase, payload } = message;
    postRunProgress(runId, apiBase, payload)
      .then((result) => {
        sendResponse({ ok: true, result });
      })
      .catch((error) => {
        console.error('Failed to post automation progress', error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }
});

chrome.action.onClicked.addListener(async () => {
  if (monitorWindowId !== null) {
    try {
      await chrome.windows.update(monitorWindowId, { focused: true });
      return;
    } catch (error) {
      monitorWindowId = null;
    }
  }
  const windowInfo = await chrome.windows.create({
    url: chrome.runtime.getURL('monitor.html'),
    type: 'popup',
    width: 380,
    height: 560,
  });
  monitorWindowId = windowInfo?.id ?? null;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === monitorWindowId) {
    monitorWindowId = null;
  }
});
