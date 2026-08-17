(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CONFIRM = 'restore-rounds-1-17';

  async function loadPlan() {
    try {
      const response = await fetch('/api/admin/marks-restore-plan', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      $('plan-status').hidden = true;
      $('plan-wrap').hidden = false;
      $('dataset-name').textContent = data.newDatasetId;

      $('plan-stats').innerHTML = `
        <div class="ov-stat"><span class="ov-stat-num">${data.totals.roundsAffected}</span><span class="ov-stat-label">Runden betroffen</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.totals.toAdd}</span><span class="ov-stat-label">hinzuzufügen</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.totals.toRemove}</span><span class="ov-stat-label">zu entfernen</span></div>
      `;

      const changed = data.rounds.filter((r) => r.toAdd.length > 0 || r.toRemove.length > 0);
      if (changed.length === 0) {
        // apply-box bleibt sichtbar (nicht ausblenden!) — sonst verschwindet nach
        // einem erfolgreichen Apply die Bestätigungsmeldung mitsamt Ergebnis-JSON,
        // weil der anschließende loadPlan()-Aufruf jetzt 0 Änderungen findet.
        $('changes-empty').hidden = false;
        $('changes-table-wrap').hidden = true;
      } else {
        $('changes-body').innerHTML = data.rounds.map((r) => `
          <tr>
            <td>${r.round}</td>
            <td>${r.unchanged}</td>
            <td>${r.toAdd.length}</td>
            <td>${r.toRemove.length}</td>
          </tr>
        `).join('');
      }
    } catch (caught) {
      $('plan-status').textContent = `Fehler: ${caught.message}`;
      $('plan-status').classList.add('error');
    }
  }

  $('apply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = $('admin-token').value.trim();
    if (!token) return;
    const submit = $('apply-submit');
    const status = $('apply-status');
    const result = $('apply-result');
    submit.disabled = true;
    result.textContent = '';
    status.textContent = 'Wird angewendet …';
    status.classList.remove('error');

    try {
      const response = await fetch('/api/admin/marks-restore-apply', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: CONFIRM }),
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok || !data.ok) {
        status.textContent = data.error || `Fehlgeschlagen (HTTP ${response.status}).`;
        status.classList.add('error');
        result.textContent = JSON.stringify(data, null, 2);
        submit.disabled = false;
        return;
      }
      status.textContent = `Fertig — ${data.applied} Markierungen geändert.`;
      result.textContent = JSON.stringify(data, null, 2);
      $('admin-token').value = '';
      await loadPlan();
    } catch (caught) {
      status.textContent = caught.message || 'Server nicht erreichbar.';
      status.classList.add('error');
    } finally {
      submit.disabled = false;
    }
  });

  loadPlan();
})();
