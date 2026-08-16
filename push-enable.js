(() => {
  'use strict';

  // Der iOS-Installationshinweis lief früher hier als Balken unter jeder
  // Runde/Übersicht (Punkt 4) — zeigt sich jetzt zentral als Pop-up direkt
  // nach dem Login (login.js). Ohne installierte App fehlt auf iOS ohnehin
  // die PushManager-Unterstützung, der folgende Guard fängt das weiterhin ab.
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;

  function b64ToUint8(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(normalized);
    const out = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) out[index] = raw.charCodeAt(index);
    return out;
  }

  async function getConfig() {
    const response = await fetch('/api/push/config', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    return response.json();
  }

  async function subscribe(publicKey) {
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
    const data = subscription.toJSON();
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: data.endpoint, keys: data.keys }),
    });
    if (!response.ok) throw new Error('Server hat das Abo abgelehnt.');
  }

  async function init() {
    try { await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }); } catch (_) { /* egal */ }
    const config = await getConfig();
    if (!config || !config.ok) return;

    const bar = document.createElement('div');
    bar.className = 'tw-push-bar';
    const settingsLink = config.reviewer === 'Philipp'
      ? ' <a class="tw-push-link" href="/push-settings.html">Benachrichtigungen steuern</a>'
      : '';

    if (config.publicKey && !config.subscribed) {
      bar.innerHTML = `<button id="tw-push-allow" class="tw-push-btn">Benachrichtigungen auf diesem Gerät erlauben</button>${settingsLink}`;
    } else if (config.reviewer === 'Philipp') {
      bar.innerHTML = `<span class="tw-push-ok">✓ Dieses Gerät ist für Benachrichtigungen eingerichtet.</span>${settingsLink}`;
    } else {
      return;
    }
    document.body.appendChild(bar);

    const allow = document.getElementById('tw-push-allow');
    if (allow) {
      allow.addEventListener('click', async () => {
        allow.disabled = true;
        allow.textContent = 'Wird eingerichtet …';
        try {
          await subscribe(config.publicKey);
          bar.innerHTML = `<span class="tw-push-ok">✓ Benachrichtigungen aktiv auf diesem Gerät.</span>${settingsLink}`;
        } catch (caught) {
          allow.disabled = false;
          allow.textContent = 'Erneut versuchen';
          const err = document.createElement('span');
          err.className = 'tw-push-err';
          err.textContent = ` ${caught.message || 'Fehler'}`;
          bar.appendChild(err);
        }
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
