import {
  CLASSIFICATION_CLASSES,
  CLASSIFICATION_KEYS,
  GROUP_LABELS,
} from './classification-classes.mjs';
import { QUALITY_FLAGS, QUALITY_FLAG_KEYS } from './quality-flags.mjs';

(() => {
  'use strict';

  const API = '/api/';

  // ?dataset=-Schalter — identisch zur Doppelprüfung (localStorage tw_dataset).
  function readDataset() {
    try {
      const fromUrl = new URLSearchParams(location.search).get('dataset');
      if (fromUrl) { localStorage.setItem('tw_dataset', fromUrl); return fromUrl; }
      return localStorage.getItem('tw_dataset') || '';
    } catch (_) { return ''; }
  }

  const state = {
    view: 'overview',
    dataset: readDataset(),
    reviewer: '',
    canUpload: false,
    partnerActive: true,
    sample: [],
    situationId: null,
    messages: [],
    classes: {},
    flags: {},
    submitted: false,
    otherSubmitted: false,
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  // Punkt 1: EINE Nummerierungslogik. Global stabile Grenz-Nummer der
  // Start-Grenze (startOrdinal) statt runden-lokaler „R{round}·{index+1}".
  // Fallback auf die alte Form nur, falls die Ordinalzahl (noch) fehlt.
  function situationTag(row) {
    if (row && row.startOrdinal != null) return `Grenze ${row.startOrdinal}`;
    return `R${row ? row.round : '?'}·${row ? row.situationIndex + 1 : '?'}`;
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

  // --------------------------------------------------- Nachrichten (wie dp)

  function messageText(message) {
    if (message.kind === 'anruf') return { text: 'Anruf', placeholder: true };
    if (message.kind === 'medien') return { text: 'Foto, Sprachnachricht oder Datei', placeholder: true };
    if (message.kind === 'leer' || !message.text) return { text: '(ohne Inhalt)', placeholder: true };
    return { text: message.text, placeholder: false };
  }

  let messageIndex = new Map();
  function setMessageIndex(messages) {
    messageIndex = new Map((messages || []).map((message) => [String(message.id), message]));
  }

  function replyPreviewHtml(message) {
    if (message.replyToId === undefined || message.replyToId === null) return '';
    const quoted = messageIndex.get(String(message.replyToId));
    if (!quoted) return '<div class="dp-reply-quote outside">↩ Antwort auf frühere Nachricht</div>';
    const { text } = messageText(quoted);
    const start = text.length > 90 ? `${text.slice(0, 90)}…` : text;
    const quotedName = String(quoted.from || '').trim().split(/\s+/u)[0] || quoted.from;
    return `<div class="dp-reply-quote"><span class="dp-reply-from">↩ ${escapeHtml(quotedName)}</span> <span class="dp-reply-text">${escapeHtml(start)}</span></div>`;
  }

  function messageHtml(message) {
    const { text, placeholder } = messageText(message);
    const time = message.t ? new Date(message.t * 1000).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    }) : '';
    const name = String(message.from || '').trim().split(/\s+/u)[0] || message.from;
    return `<div class="dp-message" data-speaker="${escapeHtml(name)}">
      <div class="dp-message-meta"><b>${escapeHtml(name)}</b> · ${escapeHtml(time)}</div>
      ${replyPreviewHtml(message)}
      <div class="dp-message-text${placeholder ? ' placeholder' : ''}">${escapeHtml(text)}</div>
    </div>`;
  }

  function renderStreamInto(containerId, messages) {
    const container = $(containerId);
    if (!container) return;
    setMessageIndex(messages);
    container.innerHTML = (messages || []).map((message) => messageHtml(message)).join('');
  }

  function setStatus(text, isError) {
    $('cl-status').textContent = text || '';
    $('cl-status').classList.toggle('error', Boolean(isError));
  }

  function showMarkState(name) {
    ['cl-state-mark', 'cl-state-waiting', 'cl-state-compare'].forEach((id) => {
      $(id).classList.toggle('dp-weg', id !== `cl-state-${name}`);
    });
  }

  // --------------------------------------------------- Checkbox-Panel

  function checkboxRow(entry, group) {
    const checked = state[group][entry.key] ? 'checked' : '';
    return `<div class="cl-check-row" data-key="${escapeHtml(entry.key)}">
      <label class="cl-check">
        <input type="checkbox" data-group="${group}" data-key="${escapeHtml(entry.key)}" ${checked}>
        <span class="cl-check-label">${escapeHtml(entry.label)}</span>
      </label>
      <button type="button" class="cl-info-dot" data-hint-for="${escapeHtml(entry.key)}" aria-label="Definition anzeigen">i</button>
      <div class="cl-hint dp-weg" id="cl-hint-${escapeHtml(entry.key)}">${escapeHtml(entry.hint)}</div>
    </div>`;
  }

  function buildCheckboxes() {
    const groups = ['risk', 'positive', 'apology'];
    const classesHtml = groups.map((group) => {
      const inGroup = CLASSIFICATION_CLASSES.filter((entry) => entry.group === group);
      if (!inGroup.length) return '';
      return `<div class="cl-group">
        <div class="cl-group-title">${escapeHtml(GROUP_LABELS[group] || group)}</div>
        ${inGroup.map((entry) => checkboxRow(entry, 'classes')).join('')}
      </div>`;
    }).join('');
    $('cl-classes').innerHTML = classesHtml;
    $('cl-flags').innerHTML = QUALITY_FLAGS.map((entry) => checkboxRow(entry, 'flags')).join('');

    bindCheckboxHandlers($('cl-classes'));
    bindCheckboxHandlers($('cl-flags'));
  }

  function bindCheckboxHandlers(root) {
    root.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        const group = input.dataset.group;
        state[group][input.dataset.key] = input.checked ? 1 : 0;
        saveMarks();
      });
    });
    root.querySelectorAll('.cl-info-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        const hint = $(`cl-hint-${dot.dataset.hintFor}`);
        if (hint) hint.classList.toggle('dp-weg');
      });
    });
  }

  function syncCheckboxes() {
    document.querySelectorAll('#cl-classes input[type="checkbox"], #cl-flags input[type="checkbox"]').forEach((input) => {
      const group = input.dataset.group;
      input.checked = Boolean(state[group][input.dataset.key]);
    });
  }

  // --------------------------------------------------- Autosave (wie dp)

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
    $('cl-save-status').textContent = 'Wird gespeichert …';
    $('cl-save-status').classList.remove('error');
    return fetchJson(`classification/situations/${state.situationId}/marks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classes: state.classes, flags: state.flags }),
    }).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
      $('cl-save-status').textContent = 'Gespeichert';
    }).catch((caught) => {
      $('cl-save-status').textContent = `Nicht gespeichert — ${caught.message}`;
      $('cl-save-status').classList.add('error');
    }).then(() => {
      saveInFlight = false;
      if (savePending) runSave();
    });
  }

  function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

  // --------------------------------------------------- Abgeben

  function submitSituation() {
    $('cl-submit').disabled = true;
    fetchJson(`classification/situations/${state.situationId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ classes: state.classes, flags: state.flags }),
    }).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
      return refreshSampleThen(() => {
        const next = nextUnsubmittedId();
        if (next && next !== state.situationId) { openSituation(next); scrollToTop(); return; }
        // Keine offene Situation mehr → aktuellen (nun abgegebenen) Stand zeigen.
        applyDetail(payload); scrollToTop();
      });
    }).catch((caught) => {
      setStatus(`Abgabe fehlgeschlagen: ${caught.message}`, true);
    }).then(() => { $('cl-submit').disabled = false; });
  }

  // --------------------------------------------------- Situation laden

  function positionLabel() {
    const index = state.sample.findIndex((entry) => entry.id === state.situationId);
    const total = state.sample.length;
    if (index < 0 || !total) return 'Situation';
    return `Situation ${index + 1} von ${total}`;
  }

  function setReviewer(role) {
    if (role) state.reviewer = role;
    document.body.dataset.reviewer = state.reviewer || '';
  }

  function applyDetail(payload) {
    state.situationId = payload.id;
    if (payload.reviewer) setReviewer(payload.reviewer);
    state.messages = payload.messages || [];
    state.classes = {};
    state.flags = {};
    for (const key of CLASSIFICATION_KEYS) state.classes[key] = payload.ownClasses && payload.ownClasses[key] ? 1 : 0;
    for (const key of QUALITY_FLAG_KEYS) state.flags[key] = payload.ownFlags && payload.ownFlags[key] ? 1 : 0;
    state.submitted = Boolean(payload.submitted);
    state.otherSubmitted = Boolean(payload.otherSubmitted);
    state.partnerActive = Boolean(payload.partnerActive);

    $('cl-sub').textContent = payload.startOrdinal != null
      ? `${state.reviewer} · Situation ab Grenze ${payload.startOrdinal}`
      : `${state.reviewer} · Runde ${payload.round}, Nr. ${payload.situationIndex + 1}`;
    $('cl-position').textContent = positionLabel();
    setStatus('', false);

    if (!state.submitted) {
      showMarkState('mark');
      renderStreamInto('cl-stream', state.messages);
      buildCheckboxes();
      $('cl-save-status').textContent = '';
      return;
    }
    if (payload.compare) {
      showMarkState('compare');
      renderStreamInto('cl-compare-stream', state.messages);
      renderCompare(payload);
      return;
    }
    // Abgegeben, aber (noch) kein Vergleich.
    showMarkState('waiting');
    renderStreamInto('cl-waiting-stream', state.messages);
    renderOwnSummary(payload);
    if (state.partnerActive) {
      $('cl-waiting-title').textContent = 'Abgegeben — wartet auf die andere Person';
      const other = state.reviewer === 'Philipp' ? 'Lena' : 'Philipp';
      $('cl-waiting-for').textContent = other;
      $('cl-waiting-text').classList.remove('dp-weg');
    } else {
      $('cl-waiting-title').textContent = 'Abgegeben';
      $('cl-waiting-text').classList.add('dp-weg');
    }
  }

  function loadSituation(id) {
    setStatus('Wird geladen …', false);
    return fetchJson(`classification/situations/${id}`).then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
      applyDetail(payload);
    }).catch((caught) => {
      setStatus(`Konnte Situation nicht laden: ${caught.message}`, true);
    });
  }

  function openSituation(id) {
    state.situationId = id;
    setView('situation');
    loadSituation(id);
    syncUrlAndNav();
  }

  // --------------------------------------------------- Eigene Zusammenfassung

  function labelFor(key) {
    const cls = CLASSIFICATION_CLASSES.find((entry) => entry.key === key);
    if (cls) return cls.label;
    const flag = QUALITY_FLAGS.find((entry) => entry.key === key);
    return flag ? flag.label : key;
  }

  function renderOwnSummary(payload) {
    const chosen = [];
    for (const key of CLASSIFICATION_KEYS) if (payload.ownClasses && payload.ownClasses[key]) chosen.push(labelFor(key));
    for (const key of QUALITY_FLAG_KEYS) if (payload.ownFlags && payload.ownFlags[key]) chosen.push(`${labelFor(key)} (Zuschnitt)`);
    const body = chosen.length
      ? `<p class="dp-hint">Deine Auswahl:</p><ul class="cl-own-list">${chosen.map((label) => `<li>${escapeHtml(label)}</li>`).join('')}</ul>`
      : '<p class="dp-hint">Du hast keine Klasse markiert.</p>';
    $('cl-waiting-summary').innerHTML = body;
  }

  // --------------------------------------------------- Vergleich

  function presentLabel(value) { return value ? 'ja' : 'nein'; }

  function renderDisputeCards(disputes, kind, containerLabel, llmMap) {
    const other = state.reviewer === 'Philipp' ? 'Lena' : 'Philipp';
    return disputes.map((dispute) => {
      // LLM-Rating als zusätzlicher Datenpunkt (nur Anzeige, keine Autorität).
      const llmHint = (llmMap && Object.prototype.hasOwnProperty.call(llmMap, dispute.key))
        ? `<span class="cl-llm-badge">LLM: ${escapeHtml(presentLabel(llmMap[dispute.key]))}</span>` : '';
      const mineOriginal = state.reviewer === 'Philipp' ? dispute.philipp : dispute.lena;
      const theirsOriginal = state.reviewer === 'Philipp' ? dispute.lena : dispute.philipp;
      const myVote = state.reviewer === 'Philipp' ? dispute.votes.philipp : dispute.votes.lena;
      const theirVote = state.reviewer === 'Philipp' ? dispute.votes.lena : dispute.votes.philipp;

      let statusHtml;
      if (dispute.resolved) {
        statusHtml = `<span class="cl-vote-badge einig">Geklärt: ${escapeHtml(presentLabel(dispute.resolvedPresent))}</span>`;
      } else {
        const bothVoted = myVote !== null && myVote !== undefined && theirVote !== null && theirVote !== undefined;
        const suffix = bothVoted ? ' — uneinig, nochmal reden' : '';
        const cls = bothVoted ? 'uneinig' : 'offen';
        const myText = (myVote === null || myVote === undefined) ? 'noch offen' : presentLabel(myVote);
        const theirText = (theirVote === null || theirVote === undefined) ? 'noch offen' : presentLabel(theirVote);
        statusHtml = `<span class="cl-vote-badge ${cls}">Klärung — Du: ${escapeHtml(myText)} · ${escapeHtml(other)}: ${escapeHtml(theirText)}${suffix}</span>`;
      }

      return `<div class="cl-dispute${dispute.resolved ? ' geklaert' : ''}" data-kind="${kind}" data-key="${escapeHtml(dispute.key)}">
        <div class="cl-dispute-label">${escapeHtml(labelFor(dispute.key))} ${llmHint}</div>
        <div class="cl-dispute-meta">Blind — Du: <b>${escapeHtml(presentLabel(mineOriginal))}</b> · ${escapeHtml(other)}: <b>${escapeHtml(presentLabel(theirsOriginal))}</b> · ${statusHtml}</div>
        <div class="cl-dispute-actions">
          <button type="button" data-present="1" class="${myVote === 1 ? 'active' : ''}">ist zutreffend</button>
          <button type="button" data-present="0" class="${myVote === 0 ? 'active' : ''}">nicht zutreffend</button>
        </div>
        <div class="cl-dispute-status"></div>
      </div>`;
    }).join('') || `<p class="dp-hint">Keine Streitfälle bei ${escapeHtml(containerLabel)} — ihr wart euch einig.</p>`;
  }

  function renderAgreements(keys, ownMap, otherMap, containerLabel) {
    const bothYes = [];
    let bothNo = 0;
    for (const key of keys) {
      const a = ownMap[key] ? 1 : 0;
      const b = otherMap[key] ? 1 : 0;
      if (a === b) {
        if (a === 1) bothYes.push(labelFor(key)); else bothNo += 1;
      }
    }
    const yesHtml = bothYes.length
      ? `<div class="cl-agree-yes">${bothYes.map((label) => `<span class="cl-agree-chip">✓ ${escapeHtml(label)}</span>`).join('')}</div>`
      : '';
    const noHtml = `<p class="dp-hint">${bothNo} ${containerLabel} von beiden nicht markiert.</p>`;
    return yesHtml + noHtml;
  }

  function bindDisputeHandlers(container) {
    container.querySelectorAll('.cl-dispute').forEach((card) => {
      const kind = card.dataset.kind;
      const key = card.dataset.key;
      const statusNode = card.querySelector('.cl-dispute-status');
      card.querySelectorAll('[data-present]').forEach((button) => {
        button.addEventListener('click', () => {
          const present = Number(button.dataset.present);
          statusNode.textContent = 'Wird gespeichert …';
          fetchJson(`classification/situations/${state.situationId}/resolve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind, key, present }),
          }).then(({ status, payload }) => {
            if (status !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
            applyDetail(payload);
          }).catch((caught) => {
            statusNode.textContent = `Nicht gespeichert — ${caught.message}`;
          });
        });
      });
    });
  }

  function renderCompare(payload) {
    const classContainer = $('cl-compare-classes');
    const llmNote = payload.llmRated ? '' : '<p class="dp-hint">Für diese Situation liegt noch kein LLM-Rating vor.</p>';
    classContainer.innerHTML = llmNote
      + renderDisputeCards(payload.classDisputes || [], 'class', 'den Klassen', payload.llmClasses || null)
      + renderAgreements(CLASSIFICATION_KEYS, payload.ownClasses || {}, payload.otherClasses || {}, 'Klassen');
    bindDisputeHandlers(classContainer);

    const flagContainer = $('cl-compare-flags');
    flagContainer.innerHTML = renderDisputeCards(payload.flagDisputes || [], 'flag', 'dem Zuschnitt')
      + renderAgreements(QUALITY_FLAG_KEYS, payload.ownFlags || {}, payload.otherFlags || {}, 'Zuschnitt-Flags');
    bindDisputeHandlers(flagContainer);
  }

  // --------------------------------------------------- Übersicht

  function nextUnsubmittedId() {
    const mineKey = state.reviewer === 'Philipp' ? 'philippSubmitted' : 'lenaSubmitted';
    const entry = state.sample.find((row) => !row[mineKey]);
    return entry ? entry.id : null;
  }

  function refreshSampleThen(after) {
    return fetchJson('classification/situations').then(({ status, payload }) => {
      if (status === 200 && payload.ok) {
        state.sample = payload.situations || [];
        if (payload.role) setReviewer(payload.role);
        state.partnerActive = Boolean(payload.partnerActive);
      }
      if (after) after();
    });
  }

  function ampelDot(ampel) {
    const map = { green: 'grün', yellow: 'gelb', red: 'rot', insufficient: 'zu wenige', none: '–' };
    return `<span class="cl-ampel cl-ampel-${escapeHtml(ampel)}" title="${escapeHtml(map[ampel] || ampel)}"></span>`;
  }

  function kappaValue(kappa, n, ampel) {
    if (ampel === 'insufficient' || kappa === null || kappa === undefined) {
      return `<span class="cl-kappa-muted">n=${n}</span>`;
    }
    return `${ampelDot(ampel)} ${kappa.toFixed(2)}`;
  }

  function autoBadge(stat) {
    if (!state.canUpload) {
      if (stat.autoEnabled) return '<span class="cl-auto cl-auto-on" title="für Dauerbetrieb freigegeben">auto ✓</span>';
      if (stat.autoEligible) return '<span class="cl-auto cl-auto-elig" title="Schwellen erfüllt">bereit</span>';
      return '';
    }
    // Philipp: klickbarer Umschalter. Freigabe ist eine bewusste Entscheidung,
    // informiert durch die Schwellen (bereit = beide Kappa erfüllt).
    const cls = stat.autoEnabled ? 'cl-auto-on' : (stat.autoEligible ? 'cl-auto-elig' : 'cl-auto-off');
    const label = stat.autoEnabled ? 'auto ✓' : (stat.autoEligible ? 'freigeben?' : 'sperren');
    const hh = (stat.kappa === null || stat.kappa === undefined) ? '' : stat.kappa;
    const hl = (stat.humanLlm && stat.humanLlm.kappa !== null && stat.humanLlm.kappa !== undefined) ? stat.humanLlm.kappa : '';
    return `<button type="button" class="cl-auto cl-auto-toggle ${cls}" data-key="${escapeHtml(stat.key)}" data-enabled="${stat.autoEnabled ? 1 : 0}" data-hh="${hh}" data-hl="${hl}" title="Für den automatischen Dauerbetrieb freigeben/sperren">${label}</button>`;
  }

  function renderKappaGroup(title, stats, withLlm) {
    if (!stats.length) return '';
    const rows = stats.map((stat) => {
      const self = stat.selfImplicating ? '<span class="cl-self" title="selbstimplizierend">◆</span>' : '';
      const hh = kappaValue(stat.kappa, stat.n, stat.ampel);
      const extra = withLlm
        ? `<div class="cl-kappa-hl">LLM ${stat.humanLlm ? kappaValue(stat.humanLlm.kappa, stat.humanLlm.n, stat.humanLlm.ampel) : '–'}</div>
           <div class="cl-kappa-alpha">α ${(stat.alpha === null || stat.alpha === undefined) ? '–' : stat.alpha.toFixed(2)}</div>
           <div class="cl-kappa-auto">${autoBadge(stat)}</div>`
        : '';
      return `<div class="cl-kappa-row${withLlm ? ' cl-kappa-row-llm' : ''}">
        <div class="cl-kappa-label">${escapeHtml(stat.label || stat.key)} ${self}</div>
        <div class="cl-kappa-value">MM ${hh}</div>
        ${extra}
      </div>`;
    }).join('');
    return `<div class="cl-kappa-group"><div class="cl-kappa-group-title">${escapeHtml(title)}</div>${rows}</div>`;
  }

  function budgetLine(summary) {
    if (!summary || !summary.budget) return '';
    const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(4)}`;
    return `${usd(summary.budget.spentMicro)} von ${usd(summary.budget.limitMicro)} verbraucht`;
  }

  function renderOverview(situations, summary) {
    const body = $('cl-overview-body');

    const infoBtn = '<a class="cl-info-btn" href="./klassifizierung-info.html">ℹ︎ Klassen nachschlagen</a>';
    const prepareBtn = state.canUpload
      ? `<div class="cl-prepare"><label>Stichprobengröße <input type="number" id="cl-sample-size" min="1" value="180" step="10"></label>
         <button type="button" id="cl-prepare-btn">Stichprobe vorbereiten</button><span id="cl-prepare-status" class="dp-hint"></span></div>`
      : '';

    if (situations.needsPreparation) {
      body.innerHTML = `<div class="cl-overview-head"><h2>Klassifizierung</h2>${infoBtn}</div>
        <p class="dp-hint">Es wurde noch keine Validierungsstichprobe vorbereitet.
        ${state.canUpload ? 'Lege sie unten an (aus allen Runden mit abgeschlossener Grenzenklärung).' : 'Bitte Philipp, die Stichprobe vorzubereiten.'}</p>
        ${prepareBtn}`;
      bindPrepare();
      return;
    }

    const progress = situations.progress || { classifiedByBoth: 0, sampleSize: 0 };
    const mineKey = state.reviewer === 'Philipp' ? 'philippSubmitted' : 'lenaSubmitted';
    const mineDone = situations.situations.filter((row) => row[mineKey]).length;

    // Kappa je Klasse: Mensch–Mensch (MM), Mensch–LLM (LLM), Alpha (3 Kodierer).
    let kappaHtml = '';
    if (summary) {
      const risk = summary.content.filter((s) => s.group === 'risk');
      const positive = summary.content.filter((s) => s.group === 'positive');
      const apology = summary.content.filter((s) => s.group === 'apology');
      const hhNote = summary.humanHuman
        ? `${summary.bothSubmittedCount} beidseitig klassifiziert`
        : (summary.partnerActive ? 'noch keine beidseitigen Abgaben' : 'Lena nicht freigeschaltet — Mensch–Mensch entfällt');
      const llmNote = summary.llmPresent ? `${summary.llmRatedCount} vom LLM bewertet` : 'noch kein LLM-Rating';
      kappaHtml = `<div class="cl-kappa">
        <div class="cl-kappa-head">Übereinstimmung je Klasse — MM = Mensch–Mensch (Cohens κ) · LLM = Mensch–LLM · α = Krippendorff (3 Kodierer)</div>
        <div class="cl-kappa-sub">${escapeHtml(hhNote)} · ${escapeHtml(llmNote)} · ◆ = selbstimplizierend</div>
        ${renderKappaGroup(GROUP_LABELS.risk, risk, true)}
        ${renderKappaGroup(GROUP_LABELS.positive, positive, true)}
        ${renderKappaGroup(GROUP_LABELS.apology, apology, true)}
        ${renderKappaGroup('Zuschnitt', summary.quality, false)}
      </div>`;
    }

    // LLM-Dritt-Rater-Steuerung (Modell/Budget/Start) — nur Philipp. Der
    // Abweichungslink steht allen offen (bei Lena i. d. R. leer).
    let llmControl = '';
    if (summary) {
      const admin = state.canUpload
        ? `<div class="cl-llm-status">LLM-Rater: <b>${summary.configured ? escapeHtml(summary.model) : 'nicht konfiguriert'}</b>${summary.configured ? ` · ${escapeHtml(budgetLine(summary))}` : ' — ANTHROPIC_API_KEY setzen'}</div>
           <div class="cl-llm-actions">
             <button type="button" id="cl-llm-rate" ${summary.configured ? '' : 'disabled'}>LLM-Rating (Stichprobe)</button>
             <button type="button" id="cl-auto-classify" ${summary.configured ? '' : 'disabled'} title="Freigegebene Klassen automatisch auf dem Rest">Dauerbetrieb (Rest)</button>
             <button type="button" id="cl-deviations-btn">Abweichungen ansehen</button>
             <span id="cl-llm-progress" class="dp-hint"></span>
           </div>`
        : '<div class="cl-llm-actions"><button type="button" id="cl-deviations-btn">Abweichungen ansehen</button></div>';
      llmControl = `<div class="cl-llm-control">${admin}</div>`;
    }

    const rows = situations.situations.map((row) => {
      const cls = row.philippSubmitted && row.lenaSubmitted ? 'ov-done'
        : row.philippSubmitted && !row.lenaSubmitted ? 'ov-lena-open'
        : !row.philippSubmitted && row.lenaSubmitted ? 'ov-philipp-open' : 'ov-both-open';
      const pIcon = row.philippSubmitted ? '✓' : 'offen';
      const lIcon = row.lenaSubmitted ? '✓' : 'offen';
      const disputes = (row.philippSubmitted && row.lenaSubmitted)
        ? (row.openDisputes > 0 ? `<span class="ov-disputes-open">${row.openDisputes}</span>` : '–')
        : '–';
      const broken = row.segmentationBroken ? '<span class="cl-broken" title="Zuschnitt strittig/fehlerhaft">⚠ Zuschnitt</span>' : '';
      return `<div class="ov-row ${cls}" data-id="${row.id}">
        <div class="ov-cell ov-c-round" data-label="Situation">${escapeHtml(situationTag(row))}</div>
        <div class="ov-cell ov-c-philipp" data-label="Philipp"><span class="ov-badge ${row.philippSubmitted ? 'done' : 'open'}">${pIcon}</span></div>
        <div class="ov-cell ov-c-lena" data-label="Lena"><span class="ov-badge ${row.lenaSubmitted ? 'done' : 'open'}">${lIcon}</span></div>
        <div class="ov-cell ov-c-disputes" data-label="Streitfälle">${disputes}</div>
        <div class="ov-cell ov-c-broken" data-label="Zuschnitt">${broken}</div>
      </div>`;
    }).join('');

    body.innerHTML = `
      <div class="cl-overview-head"><h2>Klassifizierung</h2>${infoBtn}</div>
      <div class="ov-stats">
        <div class="ov-stat"><span class="ov-stat-num">${mineDone}</span><span class="ov-stat-label">von dir klassifiziert</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${progress.classifiedByBoth}</span><span class="ov-stat-label">beidseitig klassifiziert</span></div>
        <div class="ov-stat"><span class="ov-stat-num">${progress.sampleSize}</span><span class="ov-stat-label">Situationen in der Stichprobe</span></div>
      </div>
      <p class="cl-progress-line">${mineDone} von ${progress.sampleSize} Validierungssituationen klassifiziert.</p>
      ${llmControl}
      ${kappaHtml}
      <div class="ov-table-wrap">
        <div class="ov-table" role="table">
          <div class="ov-row ov-head" role="row" aria-hidden="true">
            <div class="ov-cell ov-c-round">Situation</div>
            <div class="ov-cell ov-c-philipp">Philipp</div>
            <div class="ov-cell ov-c-lena">Lena</div>
            <div class="ov-cell ov-c-disputes">Streitfälle</div>
            <div class="ov-cell ov-c-broken">Zuschnitt</div>
          </div>
          ${rows || '<p class="ov-empty">Keine Situationen in der Stichprobe.</p>'}
        </div>
      </div>
      ${prepareBtn}`;

    body.querySelectorAll('.ov-row:not(.ov-head)').forEach((rowEl) => {
      rowEl.addEventListener('click', () => openSituation(Number(rowEl.dataset.id)));
    });
    bindPrepare();

    const devBtn = $('cl-deviations-btn');
    if (devBtn) devBtn.addEventListener('click', () => setView('deviations'));
    const rateBtn = $('cl-llm-rate');
    if (rateBtn) rateBtn.addEventListener('click', () => runLlmBatch(rateBtn, 'classification/llm-rate?limit=10'));
    const autoBtn = $('cl-auto-classify');
    if (autoBtn) autoBtn.addEventListener('click', () => runLlmBatch(autoBtn, 'classification/auto-classify?limit=10'));

    body.querySelectorAll('.cl-auto-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const enabled = btn.dataset.enabled !== '1'; // umschalten
        const payload = { patternKey: btn.dataset.key, enabled };
        if (btn.dataset.hh !== '') payload.kappaHh = Number(btn.dataset.hh);
        if (btn.dataset.hl !== '') payload.kappaHl = Number(btn.dataset.hl);
        btn.disabled = true;
        fetchJson('classification/auto-enable', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        }).then(({ status, payload: p }) => {
          if (status !== 200 || !p.ok) throw new Error(p.error || 'Fehler');
          loadOverview();
        }).catch((caught) => { btn.disabled = false; btn.textContent = `Fehler: ${caught.message}`; });
      });
    });
  }

  // Startet ein LLM-Rating batchweise, bis nichts mehr offen ist (oder ein Fehler
  // auftritt). Zeigt Fortschritt; lädt am Ende die Übersicht neu. Genutzt für die
  // Validierungsstichprobe wie für den Dauerbetrieb (unterschiedlicher Endpunkt).
  function runLlmBatch(btn, path) {
    const progress = $('cl-llm-progress');
    btn.disabled = true;
    let total = 0;
    function step() {
      progress.textContent = `Bewerte … (${total} fertig)`;
      return fetchJson(path, { method: 'POST' }).then(({ status, payload }) => {
        if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
        total += payload.rated;
        if (payload.failed > 0 && payload.errors && payload.errors.length) {
          progress.textContent = `${total} bewertet, ${payload.failed} Fehler (${escapeHtml(payload.errors[0])})`;
        }
        if (payload.remaining > 0 && payload.rated > 0) return step();
        progress.textContent = `Fertig — ${total} bewertet, noch ${payload.remaining} offen.`;
        return loadOverview();
      });
    }
    step().catch((caught) => { progress.textContent = `Abgebrochen: ${caught.message}`; })
      .then(() => { btn.disabled = false; });
  }

  // --------------------------------------------------- Abweichungsliste

  function renderDeviations(payload) {
    const body = $('cl-overview-body');
    const back = '<a class="cl-info-btn" href="#" id="cl-dev-back">← Zurück zur Übersicht</a>';
    if (!payload.deviations.length) {
      body.innerHTML = `<div class="cl-overview-head"><h2>Abweichungen (LLM ≠ ihr)</h2>${back}</div>
        <p class="dp-hint">Keine Abweichungen: Wo ihr beide einig seid, stimmt das LLM bislang zu (oder es liegt noch kein LLM-Rating vor).</p>`;
      bindDeviationsBack();
      return;
    }
    const cards = payload.deviations.map((dev) => `
      <div class="cl-dev${dev.corrected ? ' corrected' : ''}${dev.selfImplicating ? ' self' : ''}" data-id="${dev.situationId}" data-key="${escapeHtml(dev.key)}">
        <div class="cl-dev-head">
          <span class="cl-dev-class">${escapeHtml(dev.label)} ${dev.selfImplicating ? '<span class="cl-self" title="selbstimplizierend">◆</span>' : ''}</span>
          <span class="cl-dev-loc">${escapeHtml(situationTag(dev))}</span>
        </div>
        <div class="cl-dev-values">Ihr (einig): <b>${dev.humanValue ? 'ja' : 'nein'}</b> · LLM: <b>${dev.llmValue ? 'ja' : 'nein'}</b></div>
        <div class="cl-dev-actions">
          <button type="button" data-act="confirm" ${dev.corrected ? 'disabled' : ''}>${dev.corrected ? 'Bestätigt' : 'Bestätigen (LLM irrt)'}</button>
          <button type="button" data-act="review">Nochmal ansehen</button>
        </div>
      </div>`).join('');
    body.innerHTML = `<div class="cl-overview-head"><h2>Abweichungen (LLM ≠ ihr)</h2>${back}</div>
      <p class="dp-hint">${payload.open} offen von ${payload.count}. Selbstimplizierende Klassen (◆) zuerst — dort ist die Bias-Frage am relevantesten. Kein Zwang, jede zu bearbeiten.</p>
      ${cards}`;
    bindDeviationsBack();
    body.querySelectorAll('.cl-dev').forEach((card) => {
      const id = Number(card.dataset.id);
      const key = card.dataset.key;
      card.querySelector('[data-act="review"]').addEventListener('click', () => openSituation(id));
      card.querySelector('[data-act="confirm"]').addEventListener('click', (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        fetchJson('classification/deviations/confirm', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ situationId: id, key }),
        }).then(({ status, payload: p }) => {
          if (status !== 200 || !p.ok) throw new Error(p.error || 'Fehler');
          button.textContent = 'Bestätigt';
          card.classList.add('corrected');
        }).catch((caught) => { button.disabled = false; button.textContent = `Fehler: ${caught.message}`; });
      });
    });
  }

  function bindDeviationsBack() {
    const back = $('cl-dev-back');
    if (back) back.addEventListener('click', (event) => { event.preventDefault(); setView('overview'); });
  }

  function loadDeviations() {
    $('cl-sub').textContent = 'Abweichungen';
    $('cl-overview-body').innerHTML = '<p class="dp-hint">Wird geladen …</p>';
    return fetchJson('classification/deviations').then(({ status, payload }) => {
      if (status !== 200 || !payload.ok) throw new Error(payload.error || `HTTP ${status}`);
      renderDeviations(payload);
    }).catch((caught) => {
      $('cl-overview-body').innerHTML = `<p class="dp-status error">Konnte Abweichungen nicht laden: ${escapeHtml(caught.message)}</p>`;
    });
  }

  function bindPrepare() {
    const btn = $('cl-prepare-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const size = Number($('cl-sample-size').value) || 180;
      const status = $('cl-prepare-status');
      status.textContent = 'Wird vorbereitet …';
      btn.disabled = true;
      fetchJson(`classification/prepare-sample?size=${encodeURIComponent(size)}`, { method: 'POST' })
        .then(({ status: st, payload }) => {
          if (st !== 200 || !payload.ok) throw new Error(payload.error || 'Fehler');
          status.textContent = `${payload.flagged} in Stichprobe (${payload.newlyFlagged} neu, aus ${payload.derivedRounds} Runden).`;
          loadOverview();
        })
        .catch((caught) => { status.textContent = `Fehlgeschlagen: ${caught.message}`; })
        .then(() => { btn.disabled = false; });
    });
  }

  function loadOverview() {
    $('cl-sub').textContent = 'Übersicht';
    $('cl-overview-body').innerHTML = '<p class="dp-hint">Wird geladen …</p>';
    return Promise.all([
      fetchJson('classification/situations'),
      fetchJson('classification/summary'),
    ]).then(([situationsRes, summaryRes]) => {
      if (situationsRes.status !== 200 || !situationsRes.payload.ok) {
        throw new Error(situationsRes.payload.error || `HTTP ${situationsRes.status}`);
      }
      const situations = situationsRes.payload;
      state.sample = situations.situations || [];
      if (situations.role) setReviewer(situations.role);
      state.partnerActive = Boolean(situations.partnerActive);
      const summary = summaryRes.status === 200 && summaryRes.payload.ok ? summaryRes.payload : null;
      renderOverview(situations, summary);
    }).catch((caught) => {
      $('cl-overview-body').innerHTML = `<p class="dp-status error">Konnte Übersicht nicht laden: ${escapeHtml(caught.message)}</p>`;
    });
  }

  // --------------------------------------------------- Ansichten / Nav

  function syncUrlAndNav() {
    let search = '';
    if (state.view === 'overview') search = '?tab=overview';
    else if (state.view === 'deviations') search = '?tab=deviations';
    else if (state.situationId) search = `?situation=${state.situationId}`;
    const url = `${location.pathname}${search}`;
    if (`${location.pathname}${location.search}` !== url) history.replaceState(null, '', url);
    if (window.TW_NAV) window.TW_NAV.setActive(search);
  }

  function setView(view) {
    state.view = view;
    // Die Abweichungsliste nutzt denselben Container wie die Übersicht.
    $('cl-situation-picker').classList.toggle('cl-weg', view !== 'situation');
    $('cl-situation-view').classList.toggle('cl-weg', view !== 'situation');
    $('cl-overview-view').classList.toggle('cl-weg', view === 'situation');
    if (view === 'overview') loadOverview();
    else if (view === 'deviations') loadDeviations();
    syncUrlAndNav();
  }

  function moveSituation(delta) {
    const index = state.sample.findIndex((entry) => entry.id === state.situationId);
    if (index < 0) return;
    const next = index + delta;
    if (next < 0 || next >= state.sample.length) return;
    openSituation(state.sample[next].id);
  }

  // --------------------------------------------------- Init

  function boot() {
    $('cl-submit').addEventListener('click', submitSituation);
    $('cl-prev').addEventListener('click', () => moveSituation(-1));
    $('cl-next').addEventListener('click', () => moveSituation(1));
    $('cl-to-overview').addEventListener('click', () => setView('overview'));

    // canUpload für den Vorbereiten-Button.
    fetchJson('classification/access').then(({ status, payload }) => {
      if (status === 200 && payload.ok) {
        state.canUpload = Boolean(payload.canUpload);
        setReviewer(payload.role || state.reviewer);
      }
    }).catch(() => {}).then(startAtRightView);
  }

  function startAtRightView() {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    const situation = Number(params.get('situation'));
    if (tab === 'deviations') { setView('deviations'); return; }
    if (tab !== 'overview' && Number.isInteger(situation) && situation > 0) {
      // Direkt eine Situation öffnen — Sample im Hintergrund nachladen für die Navigation.
      refreshSampleThen(() => {});
      openSituation(situation);
      return;
    }
    setView('overview');
  }

  boot();
})();
