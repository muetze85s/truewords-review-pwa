(() => {
  'use strict';

  const API = '/api/';
  // ?dataset=-Schalter: welcher Prüfdatenbestand geladen wird. Merkt sich die
  // Wahl im Gerät (localStorage) und hängt sie an jeden API-Aufruf an, sodass
  // zwischen philena-2026 und philena-4y ohne Redeploy gewechselt werden kann.
  // Leer = Server-Standard (env.ACTIVE_DATASET_ID).
  function readDataset() {
    try {
      const fromUrl = new URLSearchParams(location.search).get('dataset');
      if (fromUrl) { localStorage.setItem('tw_dataset', fromUrl); return fromUrl; }
      return localStorage.getItem('tw_dataset') || '';
    } catch (_) { return ''; }
  }
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
    dataset: readDataset(),
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  function withDataset(path) {
    if (!state.dataset) return path;
    return path + (path.includes('?') ? '&' : '?') + 'dataset=' + encodeURIComponent(state.dataset);
  }

  function fetchJson(path, options) {
    return fetch(API + withDataset(path), Object.assign({ credentials: 'same-origin' }, options || {}))
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

  // Punkt 5: Nachschlagewerk id → Nachricht der aktuell gezeigten Menge, damit
  // eine Antwort die zitierte Nachricht anzeigen kann. Wird vor jeder
  // Darstellung (Runde wie Streitfall) aus der jeweiligen Nachrichtenliste
  // gefüllt. Liegt die zitierte Nachricht außerhalb (nicht im Fenster), gibt es
  // keinen Treffer → wir zeigen „Antwort auf frühere Nachricht" (Weg A).
  let messageIndex = new Map();
  function setMessageIndex(messages) {
    messageIndex = new Map((messages || []).map((message) => [String(message.id), message]));
  }

  function replyPreviewHtml(message) {
    if (message.replyToId === undefined || message.replyToId === null) return '';
    const quoted = messageIndex.get(String(message.replyToId));
    if (!quoted) {
      return '<div class="dp-reply-quote outside">↩ Antwort auf frühere Nachricht</div>';
    }
    const { text } = messageText(quoted);
    const start = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    return `<div class="dp-reply-quote"><span class="dp-reply-from">↩ ${escapeHtml(quoted.from)}</span> <span class="dp-reply-text">${escapeHtml(start)}</span></div>`;
  }

  function messageHtml(message, dim) {
    const { text, placeholder } = messageText(message);
    const time = message.t ? new Date(message.t * 1000).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    }) : '';
    return `<div class="dp-message${dim ? ' dim' : ''}" data-speaker="${escapeHtml(message.from)}">
      <div class="dp-message-meta"><b>${escapeHtml(message.from)}</b> · ${escapeHtml(time)}</div>
      ${replyPreviewHtml(message)}
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
    setMessageIndex(state.messages);
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
      refreshLiveF1();
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

  function scrollToTop() {
    // Nach der Abgabe wechselt die Ansicht; ohne das bliebe man am unteren
    // Ende der eben durchgearbeiteten Runde stehen.
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function submitRound() {
    $('dp-submit').disabled = true;
    fetchJson(`rounds/${state.round}/submit`, { method: 'POST' })
      .then(({ status, payload }) => {
        if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
        refreshLiveF1();
        return loadRound().then(() => scrollToTop());
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

  function decisionLabel(decision) {
    if (decision === 'cut') return 'Grenze';
    if (decision === 'no_cut') return 'keine Grenze';
    return '';
  }

  /** Einzelstimme als Text — null/ohne Entscheidung und explizit 'open' zeigen beide „noch offen". */
  function voteLabel(vote) {
    if (vote === 'cut') return 'Grenze';
    if (vote === 'no_cut') return 'keine Grenze';
    return 'noch offen';
  }

  /**
   * Punkt 4: sichtbarer Stand je Streitfall aus Sicht der eingeloggten Person.
   * - beide einig  → „Beide einig: … — geklärt"
   * - beide entschieden, uneinig → „Du: … · <andere>: … — uneinig, nochmal reden"
   * - sonst → „Du: … · <andere>: noch offen"
   */
  function votesMetaHtml(dispute) {
    const votes = dispute.votes || { philipp: null, lena: null };
    const other = state.reviewer === 'Philipp' ? 'Lena' : 'Philipp';
    const mine = state.reviewer === 'Philipp' ? votes.philipp : votes.lena;
    const theirs = state.reviewer === 'Philipp' ? votes.lena : votes.philipp;

    if (dispute.resolved) {
      return `<span class="dp-vote-badge einig">Beide einig: ${escapeHtml(decisionLabel(dispute.decision))} — geklärt</span>`;
    }
    const bothDecided = mine && mine !== 'open' && theirs && theirs !== 'open';
    const suffix = bothDecided ? ' — uneinig, nochmal reden' : '';
    const cls = bothDecided ? 'uneinig' : 'offen';
    return `<span class="dp-vote-badge ${cls}">Du: ${escapeHtml(voteLabel(mine))} · ${escapeHtml(other)}: ${escapeHtml(voteLabel(theirs))}${suffix}</span>`;
  }

  /** Antippen entscheidet den Streitfall — offen → Grenze → keine Grenze → offen. */
  function nextDecision(current) {
    if (current === 'cut') return 'no_cut';
    if (current === 'no_cut') return 'open';
    return 'cut';
  }

  /**
   * Baut Kontext + Streitfall-Naht als eine durchgehende Kette aus Nachrichten
   * und Naht-Markern — dieselbe Darstellung wie im Prüfstand, inklusive
   * Zeitdifferenz an jeder Naht. Die strittige Naht ist antippbar.
   */
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
        // Zeitdifferenz immer zeigen, auch wenn jemand hier markiert hat.
        const pause = pauseLabel(before, message);
        const label = tags.length ? `${pause} · ${tags.join(' · ')}` : pause;
        const markedClass = seam?.philipp && seam?.lena ? ' marked-both'
          : seam?.philipp ? ' marked-philipp'
          : seam?.lena ? ' marked-lena' : '';

        if (isCentral) {
          const decided = dispute.decision && dispute.decision !== 'open' ? decisionLabel(dispute.decision) : '';
          const centralLabel = decided ? `${label} · ${decided}` : `${label} · antippen zum Entscheiden`;
          parts.push(`<button type="button" class="dp-dispute-seam central${markedClass}" data-central-seam="${escapeHtml(dispute.seamMessageId)}" data-decision-state="${escapeHtml(dispute.decision || 'open')}">
            <span class="line"></span><span class="label">${escapeHtml(centralLabel)}</span>
          </button>`);
        } else {
          parts.push(`<div class="dp-dispute-seam${markedClass}">
            <span class="line"></span><span class="label">${escapeHtml(label)}</span>
          </div>`);
        }
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

    // Punkt 5: Zitat-Nachschlag für die Streitfall-Ansicht aus dem vollen
    // Rundenfenster (data.messages), damit Antworten die zitierte Nachricht zeigen.
    setMessageIndex(data.messages);

    const disputesContainer = $('dp-disputes');
    if (!data.disputes.length) {
      disputesContainer.innerHTML = '<p class="dp-hint">Keine Streitfälle in dieser Runde — ihr wart euch bei jeder Grenze einig.</p>';
      return;
    }
    disputesContainer.innerHTML = data.disputes.map((dispute) => `
      <div class="dp-dispute${dispute.resolved ? ` geklaert decision-${escapeHtml(dispute.decision)}` : ''}" data-seam="${escapeHtml(dispute.seamMessageId)}">
        <div class="dp-dispute-meta">${escapeHtml(pauseLabel(dispute.before, dispute.after))} · geschnitten von <b>${escapeHtml(dispute.setBy)}</b> · ${votesMetaHtml(dispute)}</div>
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

      const centralSeam = card.querySelector('[data-central-seam]');

      function resolve(decision) {
        statusNode.textContent = 'Wird gespeichert …';
        fetchJson(`rounds/${state.round}/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seamMessageId, decision, note: noteInput.value }),
        }).then(({ status, payload }) => {
          if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
          // Eigene Stimme sofort sichtbar markieren.
          card.querySelectorAll('[data-decision]').forEach((button) => {
            button.classList.toggle('active', button.dataset.decision === decision);
          });
          statusNode.textContent = 'Gespeichert — lädt gemeinsamen Stand …';
          // Auftrag 2: „geklärt" hängt jetzt an BEIDEN Stimmen. Den wahren
          // gemeinsamen Stand (Stimmen-Anzeige, geklärt/uneinig, Sortierung)
          // liefert nur der Server — deshalb neu laden statt lokal raten.
          loadAgreement();
          refreshLiveF1();
        }).catch((caught) => {
          statusNode.textContent = `Nicht gespeichert — ${caught.message}`;
        });
      }

      card.querySelectorAll('[data-decision]').forEach((button) => {
        button.addEventListener('click', () => resolve(button.dataset.decision));
      });
      if (centralSeam) {
        centralSeam.addEventListener('click', () => {
          resolve(nextDecision(centralSeam.dataset.decisionState || 'open'));
        });
      }
      noteInput.addEventListener('change', () => {
        const active = card.querySelector('[data-decision].active');
        resolve(active ? active.dataset.decision : 'open');
      });
    });
  }

  // ----------------------------------------------------- Live-F1 (Aufgabe 4)
  // Nach jeder Annotation (Markierung gespeichert, Runde abgegeben, Streitfall
  // entschieden) wird der aktuelle F1 neu vom Server geholt und oben angezeigt.
  // Rein informativ — es wird KEIN Parameter automatisch geändert; Toleranz &
  // Umgang mit „unsicher" entscheidet weiterhin die Person von Hand.
  let liveF1Timer = null;
  function setLiveF1Message(node, text, state) {
    node.innerHTML = `<span class="dp-live-item muted">${escapeHtml(text)}</span>`;
    node.dataset.state = state;
  }
  function refreshLiveF1() {
    const node = $('dp-live-f1');
    if (!node) return;
    // Kurzes Entprellen: mehrere schnelle Klicks lösen nur einen Abruf aus.
    clearTimeout(liveF1Timer);
    liveF1Timer = setTimeout(() => {
      // Aufgabe 7: harter Timeout, damit der Spinner nie endlos hängt.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      fetch(API + withDataset(`agreement/summary${agreementQuery()}`), {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      }).then((response) => {
        if (response.status === 401) { location.href = '/login.html'; throw new Error('abgemeldet'); }
        return response.json().then((payload) => ({ status: response.status, payload }));
      }).then(({ status, payload }) => {
        clearTimeout(timeout);
        if (status !== 200 || !payload.ok) { setLiveF1Message(node, 'F1: keine Daten', 'empty'); return; }
        const hasHuman = payload.agreementF1 !== null && payload.agreementF1 !== undefined;
        const hasAuto = payload.automaticVsCombined && payload.automaticVsCombined.agreementF1 !== null
          && payload.automaticVsCombined.agreementF1 !== undefined;
        // Keine beidseitig abgegebene Runde → nichts zu vergleichen, sauber melden.
        if (!payload.roundsReady || (!hasHuman && !hasAuto)) {
          setLiveF1Message(node, 'F1: keine Daten (noch keine beidseitig abgegebene Runde)', 'empty');
          return;
        }
        const human = hasHuman ? payload.agreementF1.toFixed(2) : '–';
        const auto = hasAuto ? payload.automaticVsCombined.agreementF1.toFixed(2) : '–';
        node.innerHTML = `<span class="dp-live-item">Übereinstimmung <b>${escapeHtml(human)}</b></span>`
          + `<span class="dp-live-item">Automatik vs. gemeinsam <b>${escapeHtml(auto)}</b></span>`
          + `<span class="dp-live-item muted">n=${payload.roundsReady} Runden · tol=${state.tolerance}</span>`;
        node.dataset.state = 'ready';
      }).catch((caught) => {
        clearTimeout(timeout);
        if (caught && caught.message === 'abgemeldet') return;
        const reason = caught && caught.name === 'AbortError' ? 'Zeitüberschreitung' : 'Fehler';
        setLiveF1Message(node, `F1: keine Daten (${reason})`, 'error');
      });
    }, 250);
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
      refreshLiveF1();
    });

    startAtRightRound();
  }

  // Aufgabe 4.1: Beim Laden nicht stumpf auf Runde 1 bleiben. Ein explizites
  // ?round=N (z. B. aus dem Dashboard-Link) gewinnt; sonst springt die Ansicht
  // auf die nächste noch nicht abgegebene Runde der eingeloggten Person.
  function startAtRightRound() {
    let requested = null;
    try { requested = Number(new URLSearchParams(location.search).get('round')); } catch (_) { requested = null; }
    if (Number.isInteger(requested) && requested > 0) {
      state.round = requested;
      $('dp-round-input').value = state.round;
      loadRound();
      refreshLiveF1();
      return;
    }
    fetchJson('overview').then(({ status, payload }) => {
      if (status === 200 && payload.ok) {
        const mine = payload.reviewers && payload.reviewers[payload.reviewer];
        if (mine && Number.isInteger(mine.nextRound) && mine.nextRound > 0) {
          state.round = mine.nextRound;
          $('dp-round-input').value = state.round;
        }
      }
    }).catch(() => { /* Fallback: bleibt bei Runde 1 */ }).then(() => {
      loadRound();
      refreshLiveF1();
    });
  }

  boot();
})();
