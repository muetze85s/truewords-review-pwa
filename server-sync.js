(() => {
  'use strict';

  const API_BASE = String(window.TRUEWORDS_REVIEW_API || '').replace(/\/$/, '');
  const REVIEWER_KEY = 'truewords-review-2026/reviewer';
  const REVIEWER_CONFIRMED_KEY = 'truewords-review-ui/reviewer-confirmed';
  const STORE_PREFIX = 'truewords-review-2026/';

  let reviewer = 'Philipp';
  let currentUser = null;
  let dataset = null;
  let revision = 0;
  let applyingRemote = false;
  let ready = false;
  let pendingTimer = null;
  let syncing = false;
  let pending = false;
  let pollTimer = null;

  const originalSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function patchedSetItem(key, value) {
    originalSetItem.call(this, key, value);
    if (
      this === localStorage
      && ready
      && !applyingRemote
      && dataset
      && key === STORE_PREFIX + dataset.hash
    ) {
      scheduleSync();
    }
  };

  function apiUrl(path) {
    return `${API_BASE}${path}`;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

    const response = await fetch(apiUrl(path), {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = { error: `HTTP ${response.status}` };
    }

    if (!response.ok) {
      const failure = new Error(payload?.error || `HTTP ${response.status}`);
      failure.status = response.status;
      failure.details = payload?.details;
      throw failure;
    }
    return payload;
  }

  function waitFor(selector, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      const started = Date.now();
      const observer = new MutationObserver(() => {
        const element = document.querySelector(selector);
        if (element) {
          observer.disconnect();
          resolve(element);
        } else if (Date.now() - started > timeout) {
          observer.disconnect();
          reject(new Error(`Element ${selector} wurde nicht gefunden.`));
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  async function loadFileIntoInput(selector, filename, value) {
    const input = await waitFor(selector);
    const file = new File([JSON.stringify(value)], filename, { type: 'application/json' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setReviewer(name) {
    reviewer = name === 'Lena' ? 'Lena' : 'Philipp';
    localStorage.setItem(REVIEWER_KEY, reviewer);
    localStorage.setItem(REVIEWER_CONFIRMED_KEY, '1');
  }

  function statusElement() {
    let element = document.querySelector('.tw-server-status');
    if (element) return element;

    element = document.createElement('div');
    element.className = 'tw-server-status';
    element.setAttribute('role', 'status');
    document.body.appendChild(element);
    return element;
  }

  function setStatus(text, state = 'idle') {
    const element = statusElement();
    element.textContent = text;
    element.dataset.state = state;
  }

  function hideLocalFileControls() {
    document.querySelectorAll('label.file').forEach((label) => {
      if (label.querySelector('#chat') || label.querySelector('#ann')) label.hidden = true;
    });

    const menu = document.querySelector('.tw-file-menu-content');
    if (menu && !menu.querySelector('.tw-server-note')) {
      const note = document.createElement('div');
      note.className = 'tw-server-note';
      note.textContent = 'Chat und Prüfstand werden automatisch vom privaten Server geladen.';
      menu.prepend(note);
    }
  }

  async function signOut() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => null);
    location.replace('/login.html');
  }

  function addPortalNavigation() {
    document.querySelector('.tw-portal-nav')?.remove();
    const nav = document.createElement('div');
    nav.className = 'tw-portal-nav';

    const identity = document.createElement('span');
    identity.textContent = currentUser?.email || reviewer;
    nav.appendChild(identity);

    if (currentUser?.canUpload) {
      const upload = document.createElement('a');
      upload.href = '/upload.html';
      upload.textContent = 'Uploads';
      nav.appendChild(upload);
    }

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.textContent = 'Abmelden';
    logout.addEventListener('click', signOut);
    nav.appendChild(logout);
    document.body.appendChild(nav);
  }

  async function applyAnnotations(annotations) {
    applyingRemote = true;
    try {
      await loadFileIntoInput('#ann', 'server-markierungen.json', annotations);
      await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      applyingRemote = false;
    }
  }

  async function startSession() {
    ready = false;
    const bootstrap = await api('/api/bootstrap');
    setReviewer(bootstrap.reviewer);
    dataset = bootstrap.dataset;
    revision = Number(dataset.revision || 0);

    setStatus('Chat wird geladen …', 'working');
    applyingRemote = true;
    try {
      await loadFileIntoInput('#chat', 'server-chat.json', bootstrap.chat);
      await waitFor('#ann');
      await new Promise((resolve) => setTimeout(resolve, 250));
      await loadFileIntoInput('#ann', 'server-markierungen.json', bootstrap.annotations);
      await new Promise((resolve) => setTimeout(resolve, 350));
    } finally {
      applyingRemote = false;
    }

    ready = true;
    hideLocalFileControls();
    setStatus(`Synchronisiert · Revision ${revision}`, 'ok');
    startPolling();
  }

  function currentAnnotations() {
    if (!dataset) return null;
    const raw = localStorage.getItem(STORE_PREFIX + dataset.hash);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  function scheduleSync() {
    pending = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(syncNow, 900);
    setStatus('Änderungen werden gespeichert …', 'working');
  }

  async function syncNow() {
    if (!ready || !dataset || syncing || !pending) return;
    const annotations = currentAnnotations();
    if (!annotations) return;

    syncing = true;
    pending = false;
    try {
      const result = await api('/api/state', {
        method: 'PUT',
        body: JSON.stringify({ datasetId: dataset.id, annotations }),
      });
      revision = Number(result.revision || revision + 1);
      setStatus(`Gespeichert · Revision ${revision}`, 'ok');
    } catch (caught) {
      pending = true;
      setStatus(caught?.message || 'Speichern fehlgeschlagen.', 'error');
      if (caught?.status === 401) {
        ready = false;
        location.replace('/login.html');
      }
    } finally {
      syncing = false;
    }
  }

  async function pollState() {
    if (!ready || syncing || pending || document.hidden) return;
    try {
      const remote = await api(`/api/state?dataset=${encodeURIComponent(dataset.id)}`);
      const remoteRevision = Number(remote.dataset?.revision || 0);
      if (remoteRevision <= revision) return;

      await applyAnnotations(remote.annotations);
      revision = remoteRevision;
      setStatus(`Aktualisiert · Revision ${revision}`, 'ok');
    } catch (caught) {
      if (caught?.status === 401) {
        location.replace('/login.html');
        return;
      }
      setStatus(caught?.message || 'Server nicht erreichbar.', 'error');
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(pollState, 12000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollState();
  });

  window.addEventListener('online', () => {
    setStatus('Verbindung wird aktualisiert …', 'working');
    pollState();
    syncNow();
  });

  window.addEventListener('offline', () => {
    setStatus('Offline · Änderungen bleiben lokal vorgemerkt', 'error');
  });

  window.addEventListener('beforeunload', () => {
    if (pending) syncNow();
  });

  async function boot() {
    try {
      const me = await api('/api/auth/me');
      currentUser = me.user;
      setReviewer(currentUser.role);
      addPortalNavigation();
      await startSession();
    } catch (caught) {
      if (caught?.status === 401) {
        location.replace('/login.html');
        return;
      }
      if (caught?.status === 404 && currentUser?.canUpload) {
        location.replace('/upload.html');
        return;
      }
      setStatus(caught?.message || 'Prüfsitzung konnte nicht geladen werden.', 'error');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
