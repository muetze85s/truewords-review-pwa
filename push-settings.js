(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const setStatus = (text, state = 'idle') => { status.textContent = text; status.classList.toggle('error', state === 'error'); };

  const CHECKS = [
    'reminders_lena_enabled', 'reminders_philipp_enabled',
    'notify_philipp_on_lena_submit', 'notify_lena_on_philipp_submit',
    'dispute_alert_philipp_enabled', 'dispute_alert_lena_enabled',
  ];
  const TIMES = ['lena_time_1', 'lena_time_2', 'philipp_time_1', 'philipp_time_2'];
  // Ein gemeinsamer Schwellwert, in beiden Push-Modulen gespiegelt angezeigt.
  const THRESHOLD_INPUTS = ['dispute_threshold_philipp', 'dispute_threshold_lena'];

  let publicKey = '';

  // --- Formular füllen / speichern ------------------------------------------

  function timeToggle(id) { return document.querySelector(`.tw-time-on[data-for="${id}"]`); }

  function syncTimeField(id) {
    const on = timeToggle(id);
    const input = $(id);
    input.disabled = !on.checked;
    if (!on.checked) input.classList.add('is-off'); else input.classList.remove('is-off');
  }

  function fill(data) {
    const s = data.settings || {};
    CHECKS.forEach((key) => { $(key).checked = Number(s[key]) === 1; });
    TIMES.forEach((key) => {
      const value = s[key] || '';
      $(key).value = value;
      // Eine Zeit gilt als aktiv, wenn ein Wert hinterlegt ist (leer = abgeschaltet).
      timeToggle(key).checked = value !== '';
      syncTimeField(key);
    });
    THRESHOLD_INPUTS.forEach((id) => { $(id).value = s.dispute_threshold ?? 5; });

    const dev = data.devices || {};
    $('lena-device').textContent = dev.lenaSubscribed
      ? 'Lenas Gerät: ✓ Push-Erlaubnis erteilt.'
      : 'Lenas Gerät: ✕ noch keine Erlaubnis. Lena öffnet die Doppelprüfung auf ihrem Gerät und tippt oben in der Leiste „Benachrichtigungen auf diesem Gerät erlauben".';
    $('philipp-device').textContent = dev.philippSubscribed
      ? 'Philipps Gerät(e): ✓ mindestens ein Gerät ist eingerichtet.'
      : 'Philipps Gerät(e): ✕ noch keins eingerichtet.';
  }

  async function load() {
    try {
      const response = await fetch('/api/push/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 403) { setStatus('Nur Philipp darf diese Seite steuern.', 'error'); return; }
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Konnte Einstellungen nicht laden.');
      publicKey = data.publicKey || '';
      fill(data);
      setStatus('', 'idle');
      refreshThisDevice();
    } catch (caught) {
      setStatus(caught.message || 'Laden fehlgeschlagen.', 'error');
    }
  }

  document.querySelectorAll('.tw-time-on').forEach((box) => {
    box.addEventListener('change', () => {
      const id = box.dataset.for;
      syncTimeField(id);
      if (box.checked && !$(id).value) $(id).focus();
    });
  });

  // Beide Schwellwert-Felder spiegeln denselben Wert.
  THRESHOLD_INPUTS.forEach((id) => {
    $(id).addEventListener('input', () => {
      THRESHOLD_INPUTS.forEach((other) => { if (other !== id) $(other).value = $(id).value; });
    });
  });

  $('push-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('save').disabled = true;
    setStatus('Wird gespeichert …', 'working');
    const payload = { dispute_threshold: Number($('dispute_threshold_philipp').value) };
    CHECKS.forEach((key) => { payload[key] = $(key).checked ? 1 : 0; });
    // Abgeschaltete Zeit → leeren String senden (der Server schaltet sie damit ab).
    TIMES.forEach((key) => { payload[key] = timeToggle(key).checked ? $(key).value : ''; });
    try {
      const response = await fetch('/api/push/settings', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Speichern fehlgeschlagen.');
      setStatus('Gespeichert.', 'ok');
    } catch (caught) {
      setStatus(caught.message || 'Speichern fehlgeschlagen.', 'error');
    } finally {
      $('save').disabled = false;
    }
  });

  // --- Dieses Gerät: Push-Erlaubnis direkt hier anfordern -------------------

  function b64ToUint8(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(normalized);
    const out = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
    return out;
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function currentSubscription() {
    try {
      await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      const registration = await navigator.serviceWorker.ready;
      return registration.pushManager.getSubscription();
    } catch (_) {
      return null;
    }
  }

  async function refreshThisDevice() {
    const line = $('this-device');
    const button = $('allow-here');
    if (isIos() && !isStandalone()) {
      line.innerHTML = '<b>Push braucht die installierte App.</b><br>'
        + '1. Tippe auf <b>Teilen</b> (das Quadrat mit dem Pfeil).<br>'
        + '2. Wähle <b>Zum Home-Bildschirm</b>.<br>'
        + '3. Öffne die App vom Home-Bildschirm und komm hierher zurück.';
      button.hidden = true;
      return;
    }
    if (!pushSupported()) {
      line.textContent = 'Dieses Gerät/Browser unterstützt keine Web-Push-Benachrichtigungen.';
      button.hidden = true;
      return;
    }
    if (!publicKey) {
      line.textContent = 'Push ist serverseitig noch nicht scharf (VAPID fehlt).';
      button.hidden = true;
      return;
    }
    const subscription = await currentSubscription();
    if (subscription) {
      line.textContent = '✓ Dieses Gerät ist für Benachrichtigungen eingerichtet.';
      button.hidden = true;
    } else {
      line.textContent = 'Dieses Gerät ist noch nicht eingerichtet. Ein Klick genügt:';
      button.hidden = false;
    }
  }

  $('allow-here').addEventListener('click', async () => {
    const button = $('allow-here');
    const err = $('allow-error');
    err.textContent = '';
    button.disabled = true;
    button.textContent = 'Wird eingerichtet …';
    try {
      const registration = await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Erlaubnis nicht erteilt.');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToUint8(publicKey),
        });
      }
      const json = subscription.toJSON();
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (!response.ok) throw new Error('Server hat das Abo abgelehnt.');
      $('this-device').textContent = '✓ Dieses Gerät ist jetzt für Benachrichtigungen eingerichtet.';
      button.hidden = true;
    } catch (caught) {
      err.textContent = caught.message || 'Fehler beim Einrichten.';
      button.disabled = false;
      button.textContent = 'Erneut versuchen';
    }
  });

  $('test-push').addEventListener('click', async () => {
    const btn = $('test-push');
    const result = $('test-result');
    btn.disabled = true;
    btn.textContent = 'Wird gesendet …';
    result.textContent = '';
    result.style.color = '';
    try {
      const res = await fetch('/api/push/test', { method: 'POST', credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Fehlgeschlagen.');
      result.textContent = 'Gesendet — die Benachrichtigung sollte gleich erscheinen.';
      result.style.color = 'var(--tw-status-confirmed)';
    } catch (err) {
      result.textContent = err.message || 'Fehler beim Senden.';
      result.style.color = 'var(--tw-status-unclear)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test-Push senden';
    }
  });

  // --- Abschnitt 3: Schwellwert-Optimizer ------------------------------------

  const MIN_ROUNDS_FOR_TRAINING = 20;
  let lastRecentRuns = [];

  // Optimizer-Endpunkte sind datensatzabhängig (wie die Doppelprüfung selbst) —
  // denselben ?dataset=-Schalter anhängen wie boundary-pairs.js.
  function withDataset(path) {
    let dataset = '';
    try { dataset = new URLSearchParams(location.search).get('dataset') || localStorage.getItem('tw_dataset') || ''; } catch (_) { dataset = ''; }
    if (!dataset) return path;
    return path + (path.includes('?') ? '&' : '?') + 'dataset=' + encodeURIComponent(dataset);
  }

  function fmtDateTime(iso) {
    if (!iso) return '–';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '–';
    return date.toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  }

  function renderOptimizerFacts(data) {
    $('opt-current').textContent = `${data.currentThresholdHours} Stunden`;
    const run = data.latestRun;
    if (run) {
      $('opt-last-run').textContent = fmtDateTime(run.ranAt);
      $('opt-rounds').textContent = `${run.roundsUsed} Runden`;
      $('opt-best-f1').textContent = run.bestF1.toFixed(4);
    } else {
      $('opt-last-run').textContent = 'noch nie';
      $('opt-rounds').textContent = '–';
      $('opt-best-f1').textContent = '–';
    }
    lastRecentRuns = data.recentRuns || [];
    const ready = data.readyRoundsNow ?? 0;
    const trainButton = $('opt-train');
    const hint = $('opt-hint');
    if (ready < MIN_ROUNDS_FOR_TRAINING) {
      trainButton.disabled = true;
      hint.textContent = `Braucht mindestens ${MIN_ROUNDS_FOR_TRAINING} beidseitig abgegebene Runden (aktuell ${ready}).`;
    } else {
      trainButton.disabled = false;
      hint.textContent = `${ready} beidseitig abgegebene Runden verfügbar.`;
    }
  }

  async function loadOptimizerStatus() {
    try {
      const response = await fetch(withDataset('/api/admin/optimizer-status'), { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Konnte Optimizer-Status nicht laden.');
      renderOptimizerFacts(data);
    } catch (caught) {
      $('opt-status').textContent = `Fehler: ${caught.message}`;
    }
  }

  $('opt-train').addEventListener('click', async () => {
    const button = $('opt-train');
    const statusEl = $('opt-status');
    button.disabled = true;
    statusEl.textContent = 'Training …';
    try {
      const response = await fetch(withDataset('/api/admin/optimize-threshold'), { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Optimierung fehlgeschlagen.');
      statusEl.textContent = 'Idle (bereit)';
      $('opt-last-run').textContent = fmtDateTime(new Date().toISOString());
      $('opt-rounds').textContent = `${data.roundsUsed} Runden`;
      $('opt-best-f1').textContent = data.best ? data.best.f1.toFixed(4) : '–';
      if (data.best) {
        setStatus(`Optimierung fertig! Bester Schwellwert: ${data.best.thresholdHours} h (F1 ${data.best.f1.toFixed(4)})`, 'ok');
      }
      await loadOptimizerStatus();
    } catch (caught) {
      statusEl.textContent = `Fehler: ${caught.message}`;
    } finally {
      button.disabled = false;
    }
  });

  $('opt-logs').addEventListener('click', () => {
    const wrap = $('opt-logs-wrap');
    const body = $('opt-logs-body');
    if (!wrap.hidden) { wrap.hidden = true; return; }
    body.innerHTML = lastRecentRuns.length
      ? lastRecentRuns.map((run) => `<tr>
          <td>${fmtDateTime(run.ranAt)}</td>
          <td>${run.roundsUsed}</td>
          <td>${run.bestThresholdHours} h</td>
          <td>${run.bestF1.toFixed(4)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4">Noch keine Läufe.</td></tr>';
    wrap.hidden = false;
  });

  // --- Validierungs-Split (Overfitting-Test) ---------------------------------

  const MIN_VALIDATE_ROUNDS = 10;
  let lastValidationRuns = [];

  function renderValidationFacts(data) {
    const run = data.latestRun;
    if (run) {
      $('val-last-run').textContent = fmtDateTime(run.ranAt);
      $('val-rounds').textContent = `${run.roundsTrain} / ${run.roundsValidate}`;
      $('val-f1-train').textContent = run.f1Train.toFixed(4);
      $('val-f1-validate').textContent = run.f1Validate.toFixed(4);
    } else {
      $('val-last-run').textContent = 'noch nie';
      $('val-rounds').textContent = '–';
      $('val-f1-train').textContent = '–';
      $('val-f1-validate').textContent = '–';
    }
    lastValidationRuns = data.recentRuns || [];
    const ready = data.readyRoundsNow ?? 0;
    const runButton = $('val-run');
    const hint = $('val-hint');
    if (ready < 4) {
      runButton.disabled = true;
      hint.textContent = `Braucht mindestens 4 beidseitig abgegebene Runden (aktuell ${ready}).`;
    } else {
      runButton.disabled = false;
      hint.textContent = `${ready} beidseitig abgegebene Runden verfügbar.`;
    }
    // Warnung, wenn der letzte Lauf zu wenige Validierungs-Runden hatte.
    const warn = $('val-warn');
    if (run && run.roundsValidate < MIN_VALIDATE_ROUNDS) {
      warn.hidden = false;
      warn.textContent = `Nur ${run.roundsValidate} Validierungs-Runden — Ergebnis mit Vorsicht interpretieren (belastbar erst ab ${MIN_VALIDATE_ROUNDS}).`;
    } else {
      warn.hidden = true;
    }
  }

  async function loadValidationStatus() {
    try {
      const response = await fetch(withDataset('/api/admin/validation-status'), { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Konnte Validierungs-Status nicht laden.');
      renderValidationFacts(data);
    } catch (caught) {
      $('val-status').textContent = `Fehler: ${caught.message}`;
    }
  }

  $('val-run').addEventListener('click', async () => {
    const button = $('val-run');
    const statusEl = $('val-status');
    button.disabled = true;
    statusEl.textContent = 'Validierung läuft …';
    try {
      const response = await fetch(withDataset('/api/admin/validate-split'), { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Validierung fehlgeschlagen.');
      statusEl.textContent = 'Idle (bereit)';
      const gap = Math.abs(data.f1Train - data.f1Validate);
      setStatus(`Validierung fertig! F1 Training ${data.f1Train.toFixed(4)} vs. Validierung ${data.f1Validate.toFixed(4)} (Differenz ${gap.toFixed(4)}).`, 'ok');
      await loadValidationStatus();
    } catch (caught) {
      statusEl.textContent = `Fehler: ${caught.message}`;
    } finally {
      button.disabled = false;
    }
  });

  $('val-logs').addEventListener('click', () => {
    const wrap = $('val-logs-wrap');
    const body = $('val-logs-body');
    if (!wrap.hidden) { wrap.hidden = true; return; }
    body.innerHTML = lastValidationRuns.length
      ? lastValidationRuns.map((run) => `<tr>
          <td>${fmtDateTime(run.ranAt)}</td>
          <td>${run.roundsTrain} / ${run.roundsValidate}</td>
          <td>${run.splitSeed}</td>
          <td>${run.f1Train.toFixed(4)}</td>
          <td>${run.f1Validate.toFixed(4)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5">Noch keine Läufe.</td></tr>';
    wrap.hidden = false;
  });

  // --- Abschnitt 4: Datenbank (Dataset-Schalter) -----------------------------

  const DATASETS = [
    { value: '', label: 'Aktiv (Server-Standard)' },
    { value: 'philena-4y', label: 'philena-4y (4 Jahre)' },
    { value: 'philena-2026-pilot-v4-unseen', label: 'philena-2026 (Pilot, eingefroren)' },
  ];

  function currentDataset() {
    try { return localStorage.getItem('tw_dataset') || ''; } catch (_) { return ''; }
  }

  function setupDatasetSelect() {
    const select = $('dataset-select');
    const active = currentDataset();
    DATASETS.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (entry.value === active) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', () => {
      try {
        if (select.value) localStorage.setItem('tw_dataset', select.value);
        else localStorage.removeItem('tw_dataset');
      } catch (_) { /* egal */ }
      const url = new URL(location.href);
      if (select.value) url.searchParams.set('dataset', select.value);
      else url.searchParams.delete('dataset');
      location.href = url.toString();
    });
  }

  // --- Abschnitt 5: Klassifizierung (Lena-Freischaltung) ---------------------

  function setupClassificationToggle() {
    const toggle = $('lena_classification_enabled');
    const statusNode = $('classification-status');
    if (!toggle) return;

    fetch('/api/classification/access', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => { if (data && data.ok) toggle.checked = Boolean(data.enabled); })
      .catch(() => {});

    toggle.addEventListener('change', () => {
      statusNode.textContent = 'Wird gespeichert …';
      fetch('/api/classification/access', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: toggle.checked }),
      }).then((response) => response.json()).then((data) => {
        if (!data || !data.ok) throw new Error((data && data.error) || 'Fehler');
        statusNode.textContent = data.enabled ? 'Lena ist freigeschaltet.' : 'Lena ist gesperrt.';
      }).catch((caught) => {
        statusNode.textContent = `Nicht gespeichert — ${caught.message}`;
        toggle.checked = !toggle.checked;
      });
    });
  }

  setupDatasetSelect();
  setupClassificationToggle();
  loadOptimizerStatus();
  loadValidationStatus();
  load();
})();
