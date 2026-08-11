(() => {
  'use strict';

  const form = document.getElementById('analysis-form');
  const status = document.getElementById('status');
  const submit = document.getElementById('submit');

  function setStatus(text, state = 'idle') {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function readJson() {
    const file = document.getElementById('analysis-file').files?.[0];
    if (!file) throw new Error('Vorschlagsdatei fehlt.');
    try {
      return JSON.parse(await file.text());
    } catch {
      throw new Error('Die Vorschlagsdatei ist keine gültige JSON-Datei.');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;

    try {
      const token = document.getElementById('admin-token').value.trim();
      const datasetId = document.getElementById('dataset-id').value.trim();
      const versionId = document.getElementById('version-id').value.trim();
      const label = document.getElementById('version-label').value.trim();
      if (!token) throw new Error('Admin-Zugangscode fehlt.');

      setStatus('Vorschläge werden lokal geprüft …', 'working');
      const annotations = await readJson();
      if (!Array.isArray(annotations.situations) || !annotations.assignments) {
        throw new Error('Die Datei enthält keine gültigen Situationen und Zuordnungen.');
      }
      if (!annotations.situations.length) throw new Error('Die Datei enthält keine Situationen.');

      const assignmentCount = Object.keys(annotations.assignments).length;
      setStatus(`${annotations.situations.length} Situationen und ${assignmentCount} Zuordnungen werden übertragen …`, 'working');

      const response = await fetch('/api/admin/analysis-versions/import', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          datasetId,
          versionId,
          label,
          source: 'local-heuristic-pilot-v1',
          parameters: annotations.preselection || {},
          annotations,
        }),
      });

      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || `Import fehlgeschlagen: HTTP ${response.status}`);

      document.getElementById('admin-token').value = '';
      setStatus(
        `Aktiviert: ${result.situations} Situationen, ${result.assignments} Nachrichtenzuordnungen. Philipp ${result.split.Philipp}, Lena ${result.split.Lena}.`,
        'ok',
      );
    } catch (caught) {
      setStatus(caught?.message || 'Import fehlgeschlagen.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
})();
