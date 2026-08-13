(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const status = $('status');
  const setStatus = (text, state = 'idle') => { status.textContent = text; status.dataset.state = state; };

  const CHECKS = [
    'reminders_lena_enabled', 'reminders_philipp_enabled',
    'notify_philipp_on_lena_submit', 'dispute_alert_enabled',
  ];
  const TIMES = ['lena_time_1', 'lena_time_2', 'philipp_time_1', 'philipp_time_2'];

  function fill(data) {
    const s = data.settings || {};
    CHECKS.forEach((key) => { $(key).checked = Number(s[key]) === 1; });
    TIMES.forEach((key) => { $(key).value = s[key] || ''; });
    $('dispute_threshold').value = s.dispute_threshold ?? 5;
    const dev = data.devices || {};
    $('lena-device').textContent = dev.lenaSubscribed
      ? 'Lenas Gerät: ✓ Push-Erlaubnis erteilt.'
      : 'Lenas Gerät: ✕ noch keine Erlaubnis (Lena muss auf ihrem Gerät „erlauben" tippen).';
    $('philipp-device').textContent = dev.philippSubscribed
      ? 'Dein Gerät: ✓ eingerichtet.'
      : 'Dein Gerät: ✕ noch nicht eingerichtet (auf der Doppelprüfung „erlauben" tippen).';
  }

  async function load() {
    try {
      const response = await fetch('/api/push/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 403) { setStatus('Nur Philipp darf diese Seite steuern.', 'error'); return; }
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Konnte Einstellungen nicht laden.');
      fill(data);
      setStatus('', 'idle');
    } catch (caught) {
      setStatus(caught.message || 'Laden fehlgeschlagen.', 'error');
    }
  }

  $('push-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('save').disabled = true;
    setStatus('Wird gespeichert …', 'working');
    const payload = { dispute_threshold: Number($('dispute_threshold').value) };
    CHECKS.forEach((key) => { payload[key] = $(key).checked ? 1 : 0; });
    TIMES.forEach((key) => { payload[key] = $(key).value; });
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

  load();
})();
