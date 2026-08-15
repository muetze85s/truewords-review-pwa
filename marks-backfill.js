(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let lastDatasetId = '';

  function actionLabel(action) {
    return action === 'set_cut' ? 'setzen: Grenze' : 'entfernen (keine Grenze)';
  }

  function fromLabel(from) {
    if (from === null) return '– (keine Markierung)';
    return from === 'cut' ? 'Grenze' : 'unsicher';
  }

  async function loadPlan() {
    try {
      const response = await fetch('/api/admin/marks-backfill-plan', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      $('plan-status').hidden = true;
      $('plan-wrap').hidden = false;
      lastDatasetId = data.datasetId;
      $('dataset-name').textContent = data.datasetId;

      $('plan-stats').innerHTML = `
        <div class="ov-stat"><span class="ov-stat-num">${data.resolvedSeams}</span><span class="ov-stat-label">gemeinsam geklärte Nähte</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.alreadyCorrect}</span><span class="ov-stat-label">bereits korrekt</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.changes.length}</span><span class="ov-stat-label">noch zu ändern</span></div>
      `;

      if (data.changes.length === 0) {
        $('changes-empty').hidden = false;
        $('changes-table-wrap').hidden = true;
        $('apply-box').hidden = true;
      } else {
        $('changes-body').innerHTML = data.changes.map((c) => `
          <tr>
            <td>${c.round}</td>
            <td>${c.seamMessageId}</td>
            <td>${c.reviewer}</td>
            <td>${actionLabel(c.action)}</td>
            <td>${fromLabel(c.from)}</td>
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
      const response = await fetch('/api/admin/marks-backfill-apply', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: lastDatasetId }),
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
