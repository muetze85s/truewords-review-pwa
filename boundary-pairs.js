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
    // Punkt 3: Übersicht zeigt standardmäßig nur unfertige Runden, Umschalter
    // + Seite rein clientseitig auf den bereits geladenen Daten.
    overviewShowAll: false,
    overviewPage: 0,
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
    const quotedName = String(quoted.from || '').trim().split(/\s+/u)[0] || quoted.from;
    return `<div class="dp-reply-quote"><span class="dp-reply-from">↩ ${escapeHtml(quotedName)}</span> <span class="dp-reply-text">${escapeHtml(start)}</span></div>`;
  }

  function messageHtml(message, dim) {
    const { text, placeholder } = messageText(message);
    const time = message.t ? new Date(message.t * 1000).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    }) : '';
    const name = String(message.from || '').trim().split(/\s+/u)[0] || message.from;
    return `<div class="dp-message${dim ? ' dim' : ''}" data-speaker="${escapeHtml(name)}">
      <div class="dp-message-meta"><b>${escapeHtml(name)}</b> · ${escapeHtml(time)}</div>
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
    container.dataset.reviewer = state.reviewer || '';
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

  // putMarks() auf dem Server ersetzt bei jedem Aufruf ALLE Markierungen der
  // Runde (DELETE + INSERT). Ohne Serialisierung können mehrere schnelle
  // Klicks parallele Requests auslösen, deren Antworten in der falschen
  // Reihenfolge ankommen — ein älterer (unvollständigerer) Request, der
  // NACH einem neueren fertig wird, würde dann bereits gespeicherte
  // Markierungen kommentarlos wieder löschen. Deshalb: nie mehr als ein
  // Request gleichzeitig unterwegs; kommt während eines laufenden Saves ein
  // weiterer Klick, wird nach dessen Ende einmal mit dem dann aktuellen
  // Stand nachgesendet (kein Request pro Klick, sondern der jeweils letzte
  // Stand gewinnt garantiert).
  let saveInFlight = false;
  let savePending = false;
  function saveMarks() {
    savePending = true;
    if (saveInFlight) return;
    runSave();
  }
  function runSave() {
    savePending = false;
    saveInFlight = true;
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
    }).then(() => {
      saveInFlight = false;
      if (savePending) runSave();
    });
  }

  // Nur den angeklickten Zwischenraum-Button aktualisieren statt den ganzen
  // Nachrichtenstrom (bis zu 100 Nachrichten) bei jedem Klick neu zu rendern.
  // Farbe/Fettung kommen rein über CSS aus data-reviewer (Container) +
  // data-mark (Button) — das Setzen von data-mark reicht deshalb bereits aus,
  // ohne die Nachrichten-Bubbles neu zu bauen.
  function updateSeamButton(seamId) {
    const stream = $('dp-stream');
    const button = stream && [...stream.querySelectorAll('.dp-seam')].find((el) => el.dataset.seam === seamId);
    if (!button) return;
    const index = state.messages.findIndex((message) => message.id === seamId);
    if (index < 1) return;
    const mark = state.marks.get(seamId) || '';
    const label = mark ? seamLabel(mark) : pauseLabel(state.messages[index - 1], state.messages[index]);
    button.dataset.mark = mark;
    const labelEl = button.querySelector('.label');
    if (labelEl) labelEl.textContent = label;
  }

  function toggleSeam(seamId) {
    const current = state.marks.get(seamId) || '';
    const next = nextMark(current);
    if (next) state.marks.set(seamId, next); else state.marks.delete(seamId);
    updateSeamButton(seamId);
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
        cachedOverview = null;
        return fetchJson('overview').then(({ status: oStatus, payload: oPayload }) => {
          if (oStatus === 200 && oPayload.ok) {
            cachedOverview = oPayload;
            const mine = oPayload.reviewers && oPayload.reviewers[oPayload.reviewer];
            if (mine && Number.isInteger(mine.nextRound) && mine.nextRound > 0) {
              state.round = mine.nextRound;
              $('dp-round-input').value = state.round;
              return loadRound().then(() => scrollToTop());
            }
          }
          return loadRound().then(() => scrollToTop());
        });
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
    $('dp-agreement-number').textContent = data.f0 === null ? '–' : data.f0.toFixed(2);
    $('dp-agreement-label').textContent = `F0 (Übereinstimmung) · n=${data.n}`;
    $('dp-kappa-label').textContent = `κ = ${data.kappa.toFixed(2)}`;
    // Punkt 2: pro Runde statt Gesamt-Aggregat — F1 bezieht sich ausschließlich
    // auf diese Runde (Automatik vs. GT dieser Runde), aktualisiert sich nach
    // jeder Streitfall-Klärung, F0 bleibt davon unberührt.
    const f1Value = data.automatic.vsCombined.f1;
    $('dp-round-f1').innerHTML = `<span class="dp-live-item">F1 (Automatik vs. GT dieser Runde) <b>${f1Value === null ? '–' : f1Value.toFixed(2)}</b></span>`;
    $('dp-automatic-row').innerHTML = `Automatik gegen Philipp: <b>${data.automatic.vsPhilipp.agreementF1.toFixed(2)}</b>
      · gegen Lena: <b>${data.automatic.vsLena.agreementF1.toFixed(2)}</b>
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
        <div class="dp-dispute-number">Streitfall ${escapeHtml(dispute.number)}</div>
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
        // agreementQuery() mitschicken, damit der Server denselben
        // Vergleichsdatensatz (Toleranz/Umgang mit „unsicher") zurückgibt,
        // den die Seite gerade zeigt.
        fetchJson(`rounds/${state.round}/resolve${agreementQuery()}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seamMessageId, decision, note: noteInput.value }),
        }).then(({ status, payload }) => {
          if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
          statusNode.textContent = 'Gespeichert';
          // Auftrag 2: „geklärt" hängt an BEIDEN Stimmen. Der Server liefert
          // den wahren gemeinsamen Stand (Stimmen-Anzeige, geklärt/uneinig,
          // Sortierung, F0/F1 dieser Runde) direkt in derselben Antwort mit —
          // kein zweiter Request/kein zweites Laden des Runden-Fensters mehr
          // nötig, das war der spürbar langsame Teil beim Klären.
          renderAgreement(payload.agreement);
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

  // ------------------------------------------------------------- Übersicht
  // Aufgabe 10: Runden-Tabelle als zentrale Startseite, Aufgabe 11: < 2s via
  // Bulk-API (/api/overview), Aufgabe 12: neueste oben, nach Abgabe weiter.

  let cachedOverview = null;

  function loadOverview() {
    $('dp-overview-body').innerHTML = '<p class="dp-hint">Wird geladen …</p>';
    // Gepoolte F0-/F1-Aggregate + GT-Summe kommen direkt aus /api/overview mit —
    // kein zweiter Aufruf von agreement/summary mehr nötig, der dieselbe
    // Berechnung ein zweites Mal angestoßen hätte.
    return fetchJson(`overview${agreementQuery()}`).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
      cachedOverview = payload;
      renderOverview(payload);
    }).catch((caught) => {
      $('dp-overview-body').innerHTML = `<p class="dp-status error">Konnte Übersicht nicht laden: ${escapeHtml(caught.message)}</p>`;
    });
  }

  function roundStatusClass(row) {
    if (row.philippSubmitted && row.lenaSubmitted) return 'ov-done';
    if (row.philippSubmitted && !row.lenaSubmitted) return 'ov-lena-open';
    if (!row.philippSubmitted && row.lenaSubmitted) return 'ov-philipp-open';
    return 'ov-both-open';
  }

  const OVERVIEW_PAGE_SIZE = 25;

  function renderOverview(data) {
    const pStat = data.reviewers.Philipp;
    const lStat = data.reviewers.Lena;
    const totalOpen = data.rounds.reduce((sum, row) => sum + row.openDisputes, 0);
    const totalResolved = data.rounds.reduce((sum, row) => sum + row.resolvedDisputes, 0);

    // Zähler-Kacheln beziehen sich weiterhin auf ALLE Runden, unabhängig vom
    // Sichtbarkeits-Filter unten.
    const statsHtml = `<div class="ov-stats">
      <div class="ov-stat"><span class="ov-stat-num">${data.readyRounds}</span><span class="ov-stat-label">beidseitig abgegeben</span></div>
      <div class="ov-stat"><span class="ov-stat-num">${totalOpen}</span><span class="ov-stat-label">offene Streitfälle</span></div>
      <div class="ov-stat"><span class="ov-stat-num">${data.totalRounds}</span><span class="ov-stat-label">Runden gesamt</span></div>
    </div>`;

    const allSorted = [...data.rounds].sort((a, b) => b.round - a.round);
    // Standardansicht: nur unfertige Runden (nicht beide abgegeben, oder
    // abgegeben mit noch offenen Streitfällen). Bleibt naturgemäß klein,
    // daher unpaginiert. Umschalter zeigt die volle, paginierte Historie.
    const visible = state.overviewShowAll ? allSorted : allSorted.filter((row) => !row.done);

    const totalPages = Math.max(1, Math.ceil(visible.length / OVERVIEW_PAGE_SIZE));
    if (state.overviewPage >= totalPages) state.overviewPage = totalPages - 1;
    if (state.overviewPage < 0) state.overviewPage = 0;
    const paged = state.overviewShowAll
      ? visible.slice(state.overviewPage * OVERVIEW_PAGE_SIZE, (state.overviewPage + 1) * OVERVIEW_PAGE_SIZE)
      : visible;

    const fmtF1 = (v) => v === null || v === undefined ? '–' : v.toFixed(2);

    const rows = paged.map((row) => {
      const cls = roundStatusClass(row);
      const pIcon = row.philippSubmitted ? '✓' : 'offen';
      const lIcon = row.lenaSubmitted ? '✓' : 'offen';
      const both = row.philippSubmitted && row.lenaSubmitted;
      // Punkt 18/19: Startpunkt dieser Runde nicht in der aktuellen Folge auffindbar
      // (z. B. additiv übertragene Runde aus einem anderen Datensatz) — F0/F1/GT
      // sind hier keine echten Nullen, sondern schlicht nicht berechenbar.
      const unresolvable = both && row.unresolvable;
      // F0 = Philipp vs. Lena roh. GT = combinedBoundary-Größe (F0-Paare + geklärte
      // Streitfälle), keine Kennzahl sondern eine Mengengröße. F1 = Automatik vs. GT,
      // nur final sobald keine offenen Streitfälle mehr bestehen.
      const f0 = unresolvable ? '⚠' : (both ? fmtF1(row.f0) : '–');
      const gt = unresolvable ? '⚠' : (both ? (row.gtSize ?? '–') : '–');
      const f1 = unresolvable ? '⚠' : ((both && row.openDisputes === 0) ? fmtF1(row.f1) : '–');
      const disputes = unresolvable
        ? '<span class="ov-disputes-open" title="Startpunkt der Runde in der aktuellen Nachrichtenfolge nicht auffindbar — nicht berechenbar.">⚠ unklar</span>'
        : (both
          ? (row.openDisputes > 0 ? `<span class="ov-disputes-open">${row.openDisputes}</span>` : (row.resolvedDisputes > 0 ? `${row.resolvedDisputes} geklärt` : '–'))
          : '–');
      return `<div class="ov-row ${cls}" data-round="${row.round}">
        <div class="ov-cell ov-c-round" data-label="Runde">${row.round}</div>
        <div class="ov-cell ov-c-philipp" data-label="Philipp"><span class="ov-badge ${row.philippSubmitted ? 'done' : 'open'}">${pIcon}</span></div>
        <div class="ov-cell ov-c-lena" data-label="Lena"><span class="ov-badge ${row.lenaSubmitted ? 'done' : 'open'}">${lIcon}</span></div>
        <div class="ov-cell ov-c-f0" data-label="F0">${f0}</div>
        <div class="ov-cell ov-c-disputes" data-label="Streitfälle">${disputes}</div>
        <div class="ov-cell ov-c-gt" data-label="GT">${gt}</div>
        <div class="ov-cell ov-c-f1" data-label="F1">${f1}</div>
      </div>`;
    }).join('');

    const emptyRow = paged.length
      ? ''
      : (state.overviewShowAll
        ? '<p class="ov-empty">Noch keine Runden angelegt.</p>'
        : '<p class="ov-empty">Keine offenen Runden — alles erledigt.</p>');

    const f0Agg = fmtF1(data.f0Aggregate);
    const f1Agg = fmtF1(data.f1Aggregate);
    const gtAgg = data.gtTotal ?? '–';

    const toggleHtml = `<div class="ov-toggle-row">
      <label class="ov-toggle"><input type="checkbox" id="ov-show-all" ${state.overviewShowAll ? 'checked' : ''}> Alle Runden anzeigen</label>
    </div>`;

    const paginationHtml = (state.overviewShowAll && totalPages > 1) ? `<div class="ov-pagination">
      <button type="button" id="ov-page-prev" ${state.overviewPage === 0 ? 'disabled' : ''}>← Vorherige</button>
      <span>Seite ${state.overviewPage + 1} / ${totalPages}</span>
      <button type="button" id="ov-page-next" ${state.overviewPage >= totalPages - 1 ? 'disabled' : ''}>Nächste →</button>
    </div>` : '';

    $('dp-overview-body').innerHTML = `
      ${statsHtml}
      ${toggleHtml}
      <div class="ov-table-wrap">
        <div class="ov-table" role="table">
          <div class="ov-row ov-head" role="row" aria-hidden="true">
            <div class="ov-cell ov-c-round">Runde</div>
            <div class="ov-cell ov-c-philipp">Philipp</div>
            <div class="ov-cell ov-c-lena">Lena</div>
            <div class="ov-cell ov-c-f0">F0 (Ø ${f0Agg})</div>
            <div class="ov-cell ov-c-disputes">Streitfälle</div>
            <div class="ov-cell ov-c-gt">GT (Σ ${gtAgg})</div>
            <div class="ov-cell ov-c-f1">F1 (Ø ${f1Agg})</div>
          </div>
          ${rows || emptyRow}
        </div>
      </div>
      ${paginationHtml}`;

    $('ov-show-all').addEventListener('change', (event) => {
      state.overviewShowAll = event.target.checked;
      state.overviewPage = 0;
      renderOverview(data);
    });
    const pagePrev = $('ov-page-prev');
    const pageNext = $('ov-page-next');
    if (pagePrev) pagePrev.addEventListener('click', () => { state.overviewPage -= 1; renderOverview(data); });
    if (pageNext) pageNext.addEventListener('click', () => { state.overviewPage += 1; renderOverview(data); });

    $('dp-overview-body').querySelectorAll('.ov-row:not(.ov-head)').forEach((rowEl) => {
      rowEl.addEventListener('click', () => {
        const round = Number(rowEl.dataset.round);
        state.round = round;
        $('dp-round-input').value = round;
        setTab('round');
        loadRound();
      });
    });
  }

  function navigateToNextOpen() {
    if (!cachedOverview) return;
    const mine = cachedOverview.reviewers && cachedOverview.reviewers[cachedOverview.reviewer];
    if (mine && Number.isInteger(mine.nextRound) && mine.nextRound > 0) {
      state.round = mine.nextRound;
      $('dp-round-input').value = state.round;
      loadRound();
      syncUrlAndNav();
    }
  }

  // ------------------------------------------------------------------ Tabs

  // Aufgabe 20: hält Adresszeile und die aktive Markierung im Kopfbalken in
  // Sync mit dem intern (per JS, ohne Neuladen) gewählten Tab/Runde — nav.js
  // baut den Balken nur einmal und braucht sonst keine Rückmeldung darüber.
  function syncUrlAndNav() {
    const search = state.tab === 'overview' ? '?tab=overview' : (state.round ? `?round=${state.round}` : '');
    const url = `${location.pathname}${search}`;
    if (`${location.pathname}${location.search}` !== url) history.replaceState(null, '', url);
    if (window.TW_NAV) window.TW_NAV.setActive(search);
  }

  function setTab(tab) {
    state.tab = tab;
    $('dp-round-picker').classList.toggle('dp-weg', tab !== 'round');
    $('dp-round-view').classList.toggle('dp-weg', tab !== 'round');
    $('dp-overview-view').classList.toggle('dp-weg', tab !== 'overview');
    // Punkt 13: Titelzeile bleibt sonst dauerhaft auf „Wird geladen …" stehen,
    // sobald man einmal zur Übersicht gewechselt hat.
    if (tab === 'overview') { $('dp-sub').textContent = 'Übersicht'; loadOverview(); }
    syncUrlAndNav();
  }

  // -------------------------------------------------------------------- Init

  function boot() {
    $('dp-submit').addEventListener('click', submitRound);
    $('dp-round-go').addEventListener('click', () => {
      const value = Number($('dp-round-input').value);
      state.round = Number.isInteger(value) && value > 0 ? value : 1;
      loadRound();
      syncUrlAndNav();
    });
    $('dp-round-prev').addEventListener('click', () => {
      state.round = Math.max(1, state.round - 1);
      $('dp-round-input').value = state.round;
      loadRound();
      syncUrlAndNav();
    });
    $('dp-round-next').addEventListener('click', () => {
      state.round += 1;
      $('dp-round-input').value = state.round;
      loadRound();
      syncUrlAndNav();
    });
    $('dp-tolerance').addEventListener('change', (event) => {
      state.tolerance = Number(event.target.value);
      loadAgreement();
    });
    $('dp-doubt-mode').addEventListener('change', (event) => {
      state.doubtMode = event.target.value;
      loadAgreement();
    });

    startAtRightRound();
  }

  function startAtRightRound() {
    const params = new URLSearchParams(location.search);

    if (params.get('tab') === 'overview') {
      setTab('overview');
      return;
    }

    let requested = null;
    try { requested = Number(params.get('round')); } catch (_) { requested = null; }
    if (Number.isInteger(requested) && requested > 0) {
      state.round = requested;
      $('dp-round-input').value = state.round;
      loadRound();
      return;
    }

    fetchJson('overview').then(({ status, payload }) => {
      if (status === 200 && payload.ok) {
        cachedOverview = payload;
        const mine = payload.reviewers && payload.reviewers[payload.reviewer];
        if (mine && Number.isInteger(mine.nextRound) && mine.nextRound > 0) {
          state.round = mine.nextRound;
          $('dp-round-input').value = state.round;
        }
      }
    }).catch(() => { /* Fallback: bleibt bei Runde 1 */ }).then(() => {
      loadRound();
    });
  }

  boot();
})();
