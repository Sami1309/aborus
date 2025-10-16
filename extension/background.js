const MAX_EVENTS = 50;
let monitorWindowId = null;

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
