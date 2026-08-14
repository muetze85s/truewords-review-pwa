(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const setStatus = (text, state = 'idle') => { status.textContent = text; status.classList.toggle('error', state === 'error'); };

  const CHECKS = [
    'reminders_lena_enabled', 'reminders_philipp_enabled',
    'notify_philipp_on_lena_submit', 'dispute_alert_enabled',
  ];
  const TIMES = ['lena_time_1', 'lena_time_2', 'philipp_time_1', 'philipp_time_2'];

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
    $('dispute_threshold').value = s.dispute_threshold ?? 5;

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

  $('push-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('save').disabled = true;
    setStatus('Wird gespeichert …', 'working');
    const payload = { dispute_threshold: Number($('dispute_threshold').value) };
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

  load();
})();
