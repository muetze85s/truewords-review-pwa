(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function fmtDiff(diff) {
    if (diff === 0) return '<span style="color:var(--tw-status-confirmed)">±0</span>';
    return `<span style="color:var(--tw-status-unclear);font-weight:700">${diff > 0 ? '+' : ''}${diff}</span>`;
  }

  async function load() {
    try {
      const response = await fetch('/api/admin/anchor-check', { credentials: 'same-origin', cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      $('status').hidden = true;
      $('summary-wrap').hidden = false;

      $('summary-stats').innerHTML = `
        <div class="ov-stat"><span class="ov-stat-num">${data.rounds.total}</span><span class="ov-stat-label">Runden übertragen</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.rounds.loadable}</span><span class="ov-stat-label">verankert (auffindbar)</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.marks.matched}/${data.marks.total}</span><span class="ov-stat-label">Marks passen</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${data.resolutions.matched}/${data.resolutions.total}</span><span class="ov-stat-label">Streitfälle passen</span></div>
      `;

      const verdict = $('verdict');
      if (data.allGreen) {
        verdict.innerHTML = '✅ <b>Alles grün.</b> Alle Runden, Marks und Streitfälle aus der Übertragung sind in philena-4y vollständig und unverändert wiederauffindbar. Die Daten sind nicht verloren.';
      } else {
        verdict.innerHTML = '⚠️ <b>Abweichung gefunden.</b> Siehe Tabelle unten — dort steht genau, welche Runde/welcher Wert nicht übereinstimmt.';
      }

      $('failed-rounds').textContent = data.rounds.failed.length
        ? `Nicht verankerte Runden (first_message_id in philena-4y nicht auffindbar): ${data.rounds.failed.join(', ')}`
        : 'Alle Runden sind in der aktuellen philena-4y-Nachrichtenfolge verankert.';

      $('round-body').innerHTML = (data.perRound || []).map((row) => `
        <tr>
          <td>${row.round}</td>
          <td>${row.anchored ? '✓' : '⚠ nein'}</td>
          <td>${row.marks.old}</td>
          <td>${row.marks.new}</td>
          <td>${fmtDiff(row.marks.diff)}</td>
          <td>${row.resolutions.old}</td>
          <td>${row.resolutions.new}</td>
          <td>${fmtDiff(row.resolutions.diff)}</td>
          <td>${row.messageCount.old}</td>
          <td>${row.messageCount.new}</td>
        </tr>
      `).join('');
    } catch (caught) {
      $('status').textContent = `Fehler: ${caught.message}`;
      $('status').classList.add('error');
    }
  }

  load();
})();
