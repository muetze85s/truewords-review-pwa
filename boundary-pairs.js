(() => {
  'use strict';

  const API = '/api/';
  const state = {
    round: 1,
    reviewer: '',
    messages: [],
    marks: new Map(),
    submitted: false,
    otherSubmitted: false,
    tolerance: 1,
    doubtMode: 'skip',
    tab: 'round',
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  function fetchJson(path, options) {
    return fetch(API + path, Object.assign({ credentials: 'same-origin' }, options || {}))
      .then((response) => {
        if (response.status === 401) { location.href = '/login.html'; throw new Error('abgemeldet'); }
        return response.json().then((payload) => ({ status: response.status, payload }));
      });
  }

  function messageText(message) {
    if (message.kind === 'anruf') return { text: 'Anruf', placeholder: true };
    if (message.kind === 'medien') return { text: 'Foto, Sprachnachricht oder Datei', placeholder: true };
    if (message.kind === 'leer' || !message.text) return { text: '(ohne Inhalt)', placeholder: true };
    return { text: message.text, placeholder: false };
  }

  function messageHtml(message, dim) {
    const { text, placeholder } = messageText(message);
    const time = message.t ? new Date(message.t * 1000).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }) : '';
    return `<div class="dp-message${dim ? ' dim' : ''}" data-speaker="${escapeHtml(message.from)}">
      <div class="dp-message-meta"><b>${escapeHtml(message.from)}</b> · ${escapeHtml(time)}</div>
      <div class="dp-message-text${placeholder ? ' placeholder' : ''}">${escapeHtml(text)}</div>
    </div>`;
  }

  function pauseLabel(before, after) {
    const minutes = Math.max(0, (after.t - before.t) / 60);
    if (minutes < 1) return 'gleich danach';
    if (minutes < 60) return `${Math.round(minutes)} Min. später`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} Std. ${Math.round(minutes % 60)} Min. später`;
    return `${Math.floor(minutes / 1440)} Tage später`;
  }

  // ---------------------------------------------------------------- Runde

  function seamLabel(mark) {
    if (mark === 'cut') return 'Grenze';
    if (mark === 'doubt') return 'unsicher';
    return '';
  }

  function nextMark(current) {
    if (!current) return 'cut';
    if (current === 'cut') return 'doubt';
    return null;
  }

  function renderStream(readOnly) {
    const container = readOnly ? $('dp-waiting-stream') : $('dp-stream');
    const parts = [];
    state.messages.forEach((message, index) => {
      if (index > 0) {
        const before = state.messages[index - 1];
        const mark = state.marks.get(message.id) || '';
        const label = mark ? seamLabel(mark) : pauseLabel(before, message);
        parts.push(`<button type="button" class="dp-seam" data-seam="${escapeHtml(message.id)}" data-mark="${mark}" ${readOnly ? 'disabled' : ''}>
          <span class="line"></span><span class="label">${escapeHtml(label)}</span>
        </button>`);
      }
      parts.push(messageHtml(message));
    });
    container.innerHTML = parts.join('');

    if (!readOnly) {
      container.querySelectorAll('.dp-seam').forEach((element) => {
        element.addEventListener('click', () => toggleSeam(element.dataset.seam));
      });
    }
  }

  function updateProgress() {
    const cuts = [...state.marks.values()].filter((mark) => mark === 'cut').length;
    const doubts = [...state.marks.values()].filter((mark) => mark === 'doubt').length;
    $('dp-progress-text').textContent = `${cuts} Grenze${cuts === 1 ? '' : 'n'}, ${doubts} unsicher`;
  }

  let saveTimer = null;
  function saveMarks() {
    clearTimeout(saveTimer);
    $('dp-save-status').textContent = 'Wird gespeichert …';
    $('dp-save-status').classList.remove('error');
    const marks = [...state.marks.entries()].map(([seamMessageId, mark]) => ({ seamMessageId, mark }));
    return fetchJson(`rounds/${state.round}/marks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marks }),
    }).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
      $('dp-save-status').textContent = 'Gespeichert';
    }).catch((caught) => {
      $('dp-save-status').textContent = `Nicht gespeichert — ${caught.message}`;
      $('dp-save-status').classList.add('error');
    });
  }

  function toggleSeam(seamId) {
    const current = state.marks.get(seamId) || '';
    const next = nextMark(current);
    if (next) state.marks.set(seamId, next); else state.marks.delete(seamId);
    renderStream(false);
    updateProgress();
    saveMarks();
  }

  function submitRound() {
    $('dp-submit').disabled = true;
    fetchJson(`rounds/${state.round}/submit`, { method: 'POST' })
      .then(({ status, payload }) => {
        if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
        return loadRound();
      })
      .catch((caught) => {
        setStatus(`Abgabe fehlgeschlagen: ${caught.message}`, true);
      })
      .then(() => { $('dp-submit').disabled = false; });
  }

  function setStatus(text, isError) {
    $('dp-status').textContent = text || '';
    $('dp-status').classList.toggle('error', Boolean(isError));
  }

  function showState(name) {
    ['dp-state-mark', 'dp-state-waiting', 'dp-state-compare'].forEach((id) => {
      $(id).classList.toggle('dp-weg', id !== `dp-state-${name}`);
    });
  }

  function loadRound() {
    setStatus('Wird geladen …', false);
    return fetchJson(`rounds/${state.round}`).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
      state.reviewer = payload.reviewer;
      state.messages = payload.messages;
      state.marks = new Map((payload.marks || []).map((entry) => [entry.seamMessageId, entry.mark]));
      state.submitted = Boolean(payload.submitted);
      state.otherSubmitted = Boolean(payload.otherSubmitted);
      $('dp-sub').textContent = `${state.reviewer} · Runde ${state.round}`;
      setStatus('', false);

      if (!state.submitted) {
        showState('mark');
        renderStream(false);
        updateProgress();
        $('dp-save-status').textContent = '';
        return null;
      }
      if (!state.otherSubmitted) {
        showState('waiting');
        renderStream(true);
        const other = state.reviewer === 'Philipp' ? 'Lena' : 'Philipp';
        $('dp-waiting-for').textContent = other;
        return null;
      }
      showState('compare');
      return loadAgreement();
    }).catch((caught) => {
      setStatus(`Konnte Runde nicht laden: ${caught.message}`, true);
    });
  }

  // ------------------------------------------------------------ Vergleich

  function agreementQuery() {
    return `?tol=${state.tolerance}&doubt=${state.doubtMode}`;
  }

  function loadAgreement() {
    return fetchJson(`rounds/${state.round}/agreement${agreementQuery()}`).then(({ status, payload }) => {
      if (status === 403) {
        showState('waiting');
        renderStream(true);
        $('dp-waiting-for').textContent = payload.waitingFor || 'die andere Person';
        return null;
      }
      if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
      renderAgreement(payload);
      return null;
    }).catch((caught) => {
      setStatus(`Konnte Vergleich nicht laden: ${caught.message}`, true);
    });
  }

  function seamMarkLabel(mark) {
    if (mark === 'cut') return 'Grenze';
    if (mark === 'doubt') return 'unsicher';
    return '';
  }

  /** Baut Kontext + Streitfall-Naht als eine durchgehende Kette aus Nachrichten und Naht-Markern. */
  function disputeContextHtml(dispute) {
    const parts = [];
    dispute.context.forEach((message, index) => {
      if (index > 0) {
        const before = dispute.context[index - 1];
        const seam = dispute.seams.find((entry) => entry.seamMessageId === message.id);
        const isCentral = seam && seam.position === dispute.position;
        const tags = [];
        if (seam?.philipp) tags.push(`Philipp: ${seamMarkLabel(seam.philipp)}`);
        if (seam?.lena) tags.push(`Lena: ${seamMarkLabel(seam.lena)}`);
        const label = tags.length ? tags.join(' · ') : pauseLabel(before, message);
        const markedClass = seam?.philipp && seam?.lena ? ' marked-both'
          : seam?.philipp ? ' marked-philipp'
          : seam?.lena ? ' marked-lena' : '';
        parts.push(`<div class="dp-dispute-seam${isCentral ? ' central' : ''}${markedClass}">
          <span class="line"></span><span class="label">${escapeHtml(label)}</span>
        </div>`);
      }
      const isEdge = message.id !== dispute.before.id && message.id !== dispute.after.id;
      parts.push(messageHtml(message, isEdge));
    });
    return parts.join('');
  }

  function renderAgreement(data) {
    $('dp-agreement-number').textContent = data.agreementF1 === null ? '–' : data.agreementF1.toFixed(2);
    $('dp-agreement-label').textContent = `Übereinstimmung · n=${data.n}`;
    $('dp-kappa-label').textContent = `κ = ${data.kappa.toFixed(2)}`;
    $('dp-automatic-row').innerHTML = `Automatik gegen Philipp: <b>${data.automatic.vsPhilipp.agreementF1.toFixed(2)}</b>
      · gegen Lena: <b>${data.automatic.vsLena.agreementF1.toFixed(2)}</b>
      · gegen gemeinsame Fassung: <b>${data.automatic.vsCombined.agreementF1.toFixed(2)}</b>
      <br><span class="dp-hint">Automatik hat roh ${data.automaticRaw.boundaryCount} von ${data.automaticRaw.totalSeams} Zwischenräumen als Grenze erkannt.</span>`;

    const disputesContainer = $('dp-disputes');
    if (!data.disputes.length) {
      disputesContainer.innerHTML = '<p class="dp-hint">Keine Streitfälle in dieser Runde — ihr wart euch bei jeder Grenze einig.</p>';
      return;
    }
    disputesContainer.innerHTML = data.disputes.map((dispute) => `
      <div class="dp-dispute" data-seam="${escapeHtml(dispute.seamMessageId)}">
        <div class="dp-dispute-meta">${escapeHtml(pauseLabel(dispute.before, dispute.after))} · geschnitten von <b>${escapeHtml(dispute.setBy)}</b></div>
        <div class="dp-dispute-messages">${disputeContextHtml(dispute)}</div>
        <div class="dp-dispute-actions">
          <button type="button" data-decision="cut" class="${dispute.decision === 'cut' ? 'active' : ''}">ist eine Grenze</button>
          <button type="button" data-decision="no_cut" class="${dispute.decision === 'no_cut' ? 'active' : ''}">ist keine</button>
          <button type="button" data-decision="open" class="${dispute.decision === 'open' ? 'active' : ''}">bleibt offen</button>
          <input type="text" placeholder="Notiz" value="${escapeHtml(dispute.note || '')}">
        </div>
        <div class="dp-dispute-status"></div>
      </div>
    `).join('');

    disputesContainer.querySelectorAll('.dp-dispute').forEach((card) => {
      const seamMessageId = card.dataset.seam;
      const noteInput = card.querySelector('input[type="text"]');
      const statusNode = card.querySelector('.dp-dispute-status');

      function resolve(decision) {
        statusNode.textContent = 'Wird gespeichert …';
        fetchJson(`rounds/${state.round}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seamMessageId, decision, note: noteInput.value }),
        }).then(({ status, payload }) => {
          if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
          card.querySelectorAll('[data-decision]').forEach((button) => {
            button.classList.toggle('active', button.dataset.decision === decision);
          });
          statusNode.textContent = 'Gespeichert';
        }).catch((caught) => {
          statusNode.textContent = `Nicht gespeichert — ${caught.message}`;
        });
      }

      card.querySelectorAll('[data-decision]').forEach((button) => {
        button.addEventListener('click', () => resolve(button.dataset.decision));
      });
      noteInput.addEventListener('change', () => {
        const active = card.querySelector('[data-decision].active');
        resolve(active ? active.dataset.decision : 'open');
      });
    });
  }

  // ------------------------------------------------------------- Übersicht

  function loadOverview() {
    $('dp-overview-body').innerHTML = '<p class="dp-hint">Wird geladen …</p>';
    return fetchJson(`agreement/summary${agreementQuery()}`).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
      renderOverview(payload);
    }).catch((caught) => {
      $('dp-overview-body').innerHTML = `<p class="dp-status error">Konnte Übersicht nicht laden: ${escapeHtml(caught.message)}</p>`;
    });
  }

  function renderOverview(data) {
    const lowData = data.lowData
      ? `<div class="dp-lowdata">Noch weniger als 40 beidseitig gesetzte Grenzen (${data.combinedBoundaries}) — die Übereinstimmungszahl schwankt bei dieser Menge stark und sollte nicht als belastbar gelten.</div>`
      : '';
    const overall = data.agreementF1 === null ? '–' : data.agreementF1.toFixed(2);
    const auto = data.automaticVsCombined.agreementF1 === null ? '–' : data.automaticVsCombined.agreementF1.toFixed(2);
    const rows = data.perRound.map((row) => `
      <tr>
        <td>${row.round}</td>
        <td class="n">${row.philippCuts}</td>
        <td class="n">${row.lenaCuts}</td>
        <td class="n">${row.agreementF1.toFixed(2)}</td>
        <td class="n">${row.kappa.toFixed(2)}</td>
        <td class="n">${row.resolved}/${row.disputes}</td>
        <td class="n">${row.automaticBoundaryCount}</td>
      </tr>
    `).join('');

    $('dp-overview-body').innerHTML = `
      ${lowData}
      <div class="dp-card" style="text-align:center">
        <div class="dp-agreement-number">${overall}</div>
        <div class="dp-agreement-meta"><span>Übereinstimmung über ${data.roundsReady} abgeschlossene Runden</span></div>
        <div class="dp-automatic-row">Automatik gegen die gemeinsame Fassung: <b>${auto}</b></div>
        <div class="dp-automatic-row">Automatik hat roh ${data.automaticBoundariesTotal} Grenzen über alle abgeschlossenen Runden gesetzt.</div>
        <div class="dp-automatic-row">Streitfälle: ${data.disputes.resolved} geklärt, ${data.disputes.open} offen</div>
      </div>
      <div class="dp-card" style="overflow-x:auto">
        <table class="dp-overview-table">
          <tr><th>Runde</th><th class="n">Philipp</th><th class="n">Lena</th><th class="n">Übereinst.</th><th class="n">κ</th><th class="n">Streitfälle</th><th class="n">Automatik roh</th></tr>
          ${rows || '<tr><td colspan="7">Noch keine beidseitig abgegebene Runde.</td></tr>'}
        </table>
      </div>
    `;
  }

  // ------------------------------------------------------------------ Tabs

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.dp-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    $('dp-round-picker').classList.toggle('dp-weg', tab !== 'round');
    $('dp-round-view').classList.toggle('dp-weg', tab !== 'round');
    $('dp-overview-view').classList.toggle('dp-weg', tab !== 'overview');
    if (tab === 'overview') loadOverview();
  }

  // -------------------------------------------------------------------- Init

  function boot() {
    $('dp-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('.dp-tab');
      if (button) setTab(button.dataset.tab);
    });
    $('dp-submit').addEventListener('click', submitRound);
    $('dp-round-go').addEventListener('click', () => {
      const value = Number($('dp-round-input').value);
      state.round = Number.isInteger(value) && value > 0 ? value : 1;
      loadRound();
    });
    $('dp-round-prev').addEventListener('click', () => {
      state.round = Math.max(1, state.round - 1);
      $('dp-round-input').value = state.round;
      loadRound();
    });
    $('dp-round-next').addEventListener('click', () => {
      state.round += 1;
      $('dp-round-input').value = state.round;
      loadRound();
    });
    $('dp-tolerance').addEventListener('change', (event) => {
      state.tolerance = Number(event.target.value);
      loadAgreement();
    });
    $('dp-doubt-mode').addEventListener('change', (event) => {
      state.doubtMode = event.target.value;
      loadAgreement();
    });

    loadRound();
  }

  boot();
})();
