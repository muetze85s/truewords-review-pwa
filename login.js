(() => {
  'use strict';

  const form = document.getElementById('login-form');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');
  const setupNote = document.getElementById('setup-note');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  // Punkt 4: Installationshinweis zentral nach dem Login statt als Balken
  // unter jeder Runde/Übersicht (push-enable.js) — funktioniert für Philipp
  // UND Lena gleichermaßen, da login.html unabhängig von canUpload ist.
  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true;
  }

  const INSTALL_HINT_DISMISS_KEY = 'tw_install_hint_dismissed';

  function installHintDismissed() {
    try { return localStorage.getItem(INSTALL_HINT_DISMISS_KEY) === '1'; } catch (_) { return false; }
  }

  /** Zeigt das Pop-up und löst erst nach „Weiter" auf — Redirect wartet darauf. */
  function showInstallPopup() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'tw-install-overlay';
      overlay.innerHTML = `
        <div class="tw-install-modal" role="dialog" aria-modal="true" aria-label="App installieren">
          <h2>App zum Home-Bildschirm hinzufügen</h2>
          <p>Push-Benachrichtigungen funktionieren auf dem iPhone/iPad nur über die installierte App, nicht im Browser-Tab.</p>
          <ol class="tw-install-steps">
            <li>Tippe auf <b>Teilen</b> (das Quadrat mit dem Pfeil).</li>
            <li>Wähle <b>Zum Home-Bildschirm</b>.</li>
            <li>Öffne die App künftig über das neue Icon auf dem Home-Bildschirm.</li>
          </ol>
          <label class="tw-install-dismiss"><input type="checkbox" id="tw-install-dismiss-check"> Nicht wieder anzeigen</label>
          <button type="button" id="tw-install-continue" class="primary">Weiter zur Übersicht</button>
        </div>`;
      document.body.appendChild(overlay);
      document.getElementById('tw-install-continue').addEventListener('click', () => {
        if (document.getElementById('tw-install-dismiss-check').checked) {
          try { localStorage.setItem(INSTALL_HINT_DISMISS_KEY, '1'); } catch (_) { /* egal */ }
        }
        overlay.remove();
        resolve();
      });
    });
  }

  async function checkSetup() {
    try {
      const response = await fetch('/api/auth/setup-status', { cache: 'no-store' });
      const result = await response.json();
      setupNote.hidden = result.configured !== false;
    } catch {
      setupNote.hidden = true;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    setStatus('Anmeldung wird geprüft …', 'working');

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value.trim(),
          password: document.getElementById('password').value,
        }),
        cache: 'no-store',
      });
      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || 'Anmeldung fehlgeschlagen.');

      setStatus('Angemeldet. Übersicht wird geöffnet …', 'ok');
      // Nicht erneut zeigen, sobald die App tatsächlich installiert lief
      // (Standalone erkannt) — die manuelle „Nicht wieder anzeigen"-Checkbox
      // deckt zusätzlich den Fall ab, dass jemand bewusst im Browser bleibt.
      if (isIos() && !isStandalone() && !installHintDismissed()) {
        await showInstallPopup();
      }
      location.replace('/doppelpruefung.html');
    } catch (caught) {
      setStatus(caught?.message || 'Anmeldung fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  checkSetup();
})();