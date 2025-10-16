const tabs = document.querySelectorAll('.tab-button');
const tabPanels = document.querySelectorAll('.tab');
const form = document.getElementById('record-form');
const urlInput = document.getElementById('record-url');
const feedbackCard = document.getElementById('record-feedback');
const sessionIdEl = document.getElementById('session-id');
const demoLink = document.getElementById('demo-link');
const schemaLink = document.getElementById('schema-link');
const recordingLink = document.getElementById('recording-link');
const schemasList = document.getElementById('schemas-list');
const refreshButton = document.getElementById('refresh-sessions');

function switchTab(target) {
  tabs.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === target));
  tabPanels.forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${target}`));
}

tabs.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

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

function shouldOpenOriginal(originalUrl, sessionUrl) {
  try {
    const original = new URL(originalUrl, window.location.origin);
    const session = new URL(sessionUrl, window.location.origin);
    if (original.origin === session.origin && original.pathname === session.pathname) {
      return false;
    }
    return true;
  } catch (error) {
    return true;
  }
}

function renderFeedback(data, originalUrl) {
  const { session, links } = data;
  sessionIdEl.textContent = session.session_id;
  demoLink.href = links.demo_page;
  schemaLink.href = links.schema;
  recordingLink.href = links.recording;
  feedbackCard.hidden = false;

  const originalTarget = originalUrl || session.url;
  if (links.demo_page) {
    window.open(links.demo_page, '_blank', 'noopener');
  }
  if (originalTarget && links.demo_page && shouldOpenOriginal(originalTarget, links.demo_page)) {
    window.open(originalTarget, '_blank', 'noopener');
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

function renderSessions(list) {
  if (!list.length) {
    schemasList.innerHTML = '<p class="muted">No sessions yet. Record a model to populate this list.</p>';
    return;
  }
  const fragments = list
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

form.addEventListener('submit', async (event) => {
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

refreshButton.addEventListener('click', loadSessions);

// Initialise form with demo page for convenience
if (!urlInput.value) {
  urlInput.value = `${window.location.origin}/web/test-page.html`;
}

loadSessions();
