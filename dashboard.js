(() => {
  'use strict';
  // Dashboard: zentraler Überblick. Zieht /api/overview (offene Runden je Person
  // + offene Streitfälle, älteste zuerst) und verlinkt jeden Streitfall direkt in
  // die passende Runde der Doppelprüfung. Datensatz-Kontext kommt aus dem
  // ?dataset=-Schalter (localStorage tw_dataset), damit alles zu philena-4y passt.

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  function dataset() {
    try { return localStorage.getItem('tw_dataset') || ''; } catch (_) { return ''; }
  }

  function withDataset(path) {
    const ds = dataset();
    if (!ds) return path;
    return path + (path.includes('?') ? '&' : '?') + 'dataset=' + encodeURIComponent(ds);
  }

  function pauseLabel(seconds) {
    const minutes = Math.max(0, seconds / 60);
    if (minutes < 1) return 'gleich danach';
    if (minutes < 60) return `${Math.round(minutes)} Min. Pause`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} Std. Pause`;
    return `${Math.floor(minutes / 1440)} Tage Pause`;
  }

  function roundLink(round) {
    return withDataset(`/doppelpruefung.html?round=${encodeURIComponent(round)}`);
  }

  function renderStats(data) {
    const p = data.reviewers.Philipp;
    const l = data.reviewers.Lena;
    $('db-philipp-open').textContent = p.open;
    $('db-philipp-meta').textContent = `${p.submitted} abgegeben · nächste offene: Runde ${p.nextRound}`;
    $('db-lena-open').textContent = l.open;
    $('db-lena-meta').textContent = `${l.submitted} abgegeben · nächste offene: Runde ${l.nextRound}`;
    $('db-disputes-open').textContent = data.openDisputes.length;
    $('db-rounds-meta').textContent = `${data.readyRounds} von ${data.totalRounds} Runden beidseitig abgegeben`;
    $('db-status-block').hidden = false;
  }

  function renderDisputes(data) {
    const list = $('db-disputes-list');
    if (!data.openDisputes.length) {
      list.innerHTML = '<p class="db-empty">Keine offenen Streitfälle — alles geklärt. 🎉</p>';
      $('db-disputes-section').hidden = false;
      return;
    }
    list.innerHTML = data.openDisputes.map((dispute) => `
      <button type="button" class="db-dispute" data-round="${escapeHtml(dispute.round)}">
        <span class="db-dispute-round">Runde ${escapeHtml(dispute.round)}</span>
        <span class="db-dispute-info">
          gesetzt von <b>${escapeHtml(dispute.setBy)}</b>
          <span class="muted">· ${escapeHtml(pauseLabel(dispute.pauseSeconds))}</span>
        </span>
        <span class="db-dispute-go" aria-hidden="true">→</span>
      </button>
    `).join('');
    list.querySelectorAll('.db-dispute').forEach((button) => {
      button.addEventListener('click', () => { location.href = roundLink(button.dataset.round); });
    });
    $('db-disputes-section').hidden = false;
  }

  async function load() {
    const status = $('db-status');
    try {
      const response = await fetch(withDataset('/api/overview'), { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) { location.href = '/login.html'; return; }
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      status.hidden = true;
      renderStats(data);
      renderDisputes(data);
    } catch (caught) {
      status.textContent = `Konnte den Überblick nicht laden: ${caught.message}`;
      status.classList.add('error');
    }
  }

  load();
})();
