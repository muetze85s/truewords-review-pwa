(() => {
  'use strict';

  const QUIZ_VERSION = 1;
  const STORAGE_KEY = `truewords/situation-quiz/v${QUIZ_VERSION}`;
  const card = document.getElementById('quiz-card');

  const scenarios = [
    {
      id: 'q01',
      title: 'Organisation – plötzlich ein altes Thema',
      intro: 'Ein laufendes Abendgespräch wechselt kurz auf ein Thema von vorgestern und danach wieder zurück.',
      before: [
        { time: '18:05', speaker: 'Lena', text: 'Was wollen wir heute essen?' },
        { time: '18:07', speaker: 'Philipp', text: 'Ich könnte noch Gemüse holen. Brauchen wir sonst was?' },
        { time: '18:10', speaker: 'Lena', text: 'Milch wäre gut. Und vielleicht Reis.' },
      ],
      gap: '2 Minuten später · Themenwechsel',
      after: [
        { time: '18:12', speaker: 'Philipp', text: 'Übrigens, wegen der Versicherung von vorgestern: Hast du die Mail noch gefunden?' },
        { time: '18:15', speaker: 'Lena', text: 'Ja, die schicke ich dir gleich. Beim Essen lieber Curry oder Pfanne?' },
        { time: '18:17', speaker: 'Philipp', text: 'Curry.' },
      ],
    },
    {
      id: 'q02',
      title: 'Paket – längere Pause, derselbe Vorgang',
      intro: 'Es geht um eine konkrete Lieferung. Danach ist längere Zeit nichts zu schreiben.',
      before: [
        { time: '09:00', speaker: 'Philipp', text: 'Der Fahrer soll heute zwischen neun und elf kommen.' },
        { time: '09:04', speaker: 'Lena', text: 'Okay. Sag mir kurz Bescheid, wenn er da ist.' },
      ],
      gap: '1 Stunde 36 Minuten Pause',
      after: [
        { time: '10:40', speaker: 'Philipp', text: 'Er ist gerade da.' },
        { time: '10:42', speaker: 'Lena', text: 'Super. Stell das Paket bitte vor die Tür.' },
      ],
    },
    {
      id: 'q03',
      title: 'Konflikt – Gespräch bewusst unterbrochen',
      intro: 'Ein Streit wird ausdrücklich beendet und einige Stunden später wieder aufgenommen.',
      before: [
        { time: '11:10', speaker: 'Lena', text: 'Mich hat der Satz gerade wirklich verletzt.' },
        { time: '11:14', speaker: 'Philipp', text: 'Ich wollte damit nicht sagen, was du gerade daraus machst.' },
        { time: '11:22', speaker: 'Lena', text: 'Ich will gerade nicht weiterreden. Lass uns später sprechen.' },
      ],
      gap: '4 Stunden 20 Minuten Pause',
      after: [
        { time: '15:42', speaker: 'Lena', text: 'Wegen heute Vormittag: Ich möchte dir erklären, warum mich das so getroffen hat.' },
        { time: '15:46', speaker: 'Philipp', text: 'Okay. Ich höre dir zu.' },
      ],
    },
    {
      id: 'q04',
      title: 'Gute Nacht – am Morgen direkt dasselbe Problem',
      intro: 'Beide gehen ausdrücklich schlafen. Am nächsten Morgen wird das ungelöste Thema sofort wieder aufgenommen.',
      before: [
        { time: '23:18', speaker: 'Philipp', text: 'So kommen wir heute nicht mehr weiter.' },
        { time: '23:24', speaker: 'Lena', text: 'Dann lass uns morgen darüber reden. Gute Nacht.' },
        { time: '23:26', speaker: 'Philipp', text: 'Gute Nacht. Ich gehe jetzt auch ins Bett.' },
      ],
      gap: '8 Stunden 05 Minuten · beide schlafen',
      after: [
        { time: '07:31', speaker: 'Lena', text: 'Guten Morgen. Wegen gestern: Ich glaube, mein eigentlicher Punkt ist nicht angekommen.' },
        { time: '07:36', speaker: 'Philipp', text: 'Guten Morgen. Dann sag mir bitte nochmal genau, was du meinst.' },
      ],
    },
    {
      id: 'q05',
      title: 'Gute Nacht – am Morgen ein anderes Thema',
      intro: 'Der Abend endet gemeinsam. Am Morgen beginnt etwas völlig Alltägliches.',
      before: [
        { time: '22:50', speaker: 'Lena', text: 'Dann sehen wir uns morgen gegen Mittag.' },
        { time: '23:03', speaker: 'Philipp', text: 'Passt. Gute Nacht, ich lege das Handy jetzt weg.' },
        { time: '23:04', speaker: 'Lena', text: 'Ich gehe auch schlafen. Gute Nacht ❤️' },
      ],
      gap: '8 Stunden 16 Minuten · beide schlafen',
      after: [
        { time: '07:20', speaker: 'Lena', text: 'Guten Morgen ☀️ Hast du schon Kaffee?' },
        { time: '07:24', speaker: 'Philipp', text: 'Noch nicht. Ich mache gerade welchen.' },
      ],
    },
    {
      id: 'q06',
      title: 'Unterwegs – viele Stunden ohne Nachricht',
      intro: 'Ein gemeinsamer organisatorischer Vorgang läuft über mehrere Stunden weiter, obwohl kaum geschrieben wird.',
      before: [
        { time: '08:00', speaker: 'Philipp', text: 'Die Fähre ist gebucht. Ich fahre gleich los.' },
        { time: '08:15', speaker: 'Lena', text: 'Okay. Schreib kurz, wenn du am Pier bist.' },
      ],
      gap: '5 Stunden 40 Minuten Pause',
      after: [
        { time: '13:55', speaker: 'Philipp', text: 'Bin jetzt am Pier. Die Fähre hat Verspätung.' },
        { time: '14:02', speaker: 'Lena', text: 'Alles klar. Dann rechne ich eine Stunde später mit dir.' },
      ],
    },
    {
      id: 'q07',
      title: 'Telefonat erledigt – danach neues Alltagsproblem',
      intro: 'Ein kurzer Austausch endet praktisch. Wenig später kommt ein ganz anderes Anliegen.',
      before: [
        { time: '14:00', speaker: 'Lena', text: 'Kannst du kurz telefonieren?' },
        { time: '14:10', speaker: 'Philipp', text: 'Gerade nicht. In ungefähr einer halben Stunde.' },
        { time: '14:12', speaker: 'Lena', text: 'Okay, dann später.' },
      ],
      gap: '38 Minuten Pause',
      after: [
        { time: '14:50', speaker: 'Lena', text: 'Übrigens, die Waschmaschine macht wieder dieses komische Geräusch.' },
        { time: '14:54', speaker: 'Philipp', text: 'Dann schaue ich sie mir heute Abend an.' },
      ],
    },
    {
      id: 'q08',
      title: 'Altes Streitthema mitten in einer aktuellen Planung',
      intro: 'Während eines laufenden organisatorischen Gesprächs wird ein älteres Konfliktthema eingeschoben.',
      before: [
        { time: '17:00', speaker: 'Lena', text: 'Für das Hotel brauchen wir noch die genauen Daten.' },
        { time: '17:04', speaker: 'Philipp', text: 'Freitag bis Montag wäre bei mir am besten.' },
      ],
      gap: '4 Minuten später · anderes Thema',
      after: [
        { time: '17:08', speaker: 'Lena', text: 'Bevor ich es vergesse: Wegen vorgestern bin ich immer noch nicht ganz okay.' },
        { time: '17:12', speaker: 'Philipp', text: 'Das können wir gleich in Ruhe besprechen.' },
        { time: '17:15', speaker: 'Lena', text: 'Okay. Ich schaue erstmal nach den Hotelpreisen für Freitag bis Montag.' },
      ],
    },
    {
      id: 'q09',
      title: 'Guten Abend – derselbe organisatorische Vorgang',
      intro: 'Morgens wird etwas vereinbart. Am Abend gibt es die dazugehörige Rückmeldung.',
      before: [
        { time: '10:12', speaker: 'Lena', text: 'Rufst du heute beim Tierarzt an?' },
        { time: '10:18', speaker: 'Philipp', text: 'Ja. Ich melde mich, wenn ich einen Termin habe.' },
        { time: '10:30', speaker: 'Lena', text: 'Perfekt. Dann bis später.' },
      ],
      gap: '7 Stunden 31 Minuten Pause',
      after: [
        { time: '18:01', speaker: 'Philipp', text: 'Guten Abend. Der Tierarzt hat angerufen: Donnerstag um zehn geht.' },
        { time: '18:05', speaker: 'Lena', text: 'Donnerstag passt.' },
      ],
    },
    {
      id: 'q10',
      title: 'Frage vor dem Schlafen – Antwort erst am Morgen',
      intro: 'Eine konkrete Frage bleibt offen, weil beide schlafen gehen. Die erste inhaltliche Nachricht am Morgen beantwortet genau diese Frage.',
      before: [
        { time: '00:05', speaker: 'Lena', text: 'Hast du die Miete eigentlich schon überwiesen?' },
        { time: '00:07', speaker: 'Philipp', text: 'Ich bin todmüde. Ich gehe jetzt ins Bett.' },
        { time: '00:08', speaker: 'Lena', text: 'Ich auch. Gute Nacht.' },
      ],
      gap: '8 Stunden 02 Minuten · beide schlafen',
      after: [
        { time: '08:10', speaker: 'Philipp', text: 'Guten Morgen. Ja, die Miete habe ich gestern Nachmittag überwiesen.' },
        { time: '08:13', speaker: 'Lena', text: 'Guten Morgen. Super, danke.' },
      ],
    },
  ];

  let index = 0;
  let answers = loadAnswers();

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function loadAnswers() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistAnswers() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(answers));
  }

  function speakerClass(speaker) {
    return speaker === 'Philipp' ? 'philipp' : 'lena';
  }

  function chatLine(message) {
    return `
      <article class="chat-line ${speakerClass(message.speaker)}">
        <div class="chat-meta"><strong>${escapeHtml(message.speaker)}</strong><span>${escapeHtml(message.time)}</span></div>
        <div class="chat-text">${escapeHtml(message.text)}</div>
      </article>`;
  }

  function renderScenario() {
    const scenario = scenarios[index];
    const selected = answers[scenario.id] || '';
    const percentage = ((index + 1) / scenarios.length) * 100;
    card.innerHTML = `
      <div class="quiz-progress">
        <strong>${index + 1} / ${scenarios.length}</strong>
        <div class="progress-track" aria-hidden="true"><span style="width:${percentage}%"></span></div>
      </div>
      <div class="scenario-head">
        <h2>${escapeHtml(scenario.title)}</h2>
        <p>${escapeHtml(scenario.intro)}</p>
      </div>
      <div class="transcript">
        ${scenario.before.map(chatLine).join('')}
        <div class="decision-line">
          <span></span>
          <span class="decision-label">Prüfpunkt · ${escapeHtml(scenario.gap)}</span>
          <span></span>
        </div>
        ${scenario.after.map(chatLine).join('')}
      </div>
      <div class="question">
        <h3>Was ist ab dem Prüfpunkt für dich?</h3>
        <div class="choice-grid">
          <button type="button" class="choice ${selected === 'same' ? 'selected' : ''}" data-decision="same">
            Dieselbe Situation
            <span>Der zusammenhängende Vorgang läuft für mich weiter.</span>
          </button>
          <button type="button" class="choice ${selected === 'new' ? 'selected' : ''}" data-decision="new">
            Eine neue Situation
            <span>Für mich beginnt dort ein neuer Gesprächsvorgang.</span>
          </button>
        </div>
      </div>
      <div class="quiz-nav">
        <button type="button" data-nav="back" ${index === 0 ? 'disabled' : ''}>Zurück</button>
        <button type="button" class="next" data-nav="next" ${selected ? '' : 'disabled'}>${index === scenarios.length - 1 ? 'Antworten prüfen' : 'Weiter'}</button>
      </div>`;

    card.querySelectorAll('[data-decision]').forEach((button) => {
      button.addEventListener('click', () => {
        answers[scenario.id] = button.dataset.decision;
        persistAnswers();
        renderScenario();
      });
    });
    card.querySelector('[data-nav="back"]')?.addEventListener('click', () => {
      index = Math.max(0, index - 1);
      renderScenario();
    });
    card.querySelector('[data-nav="next"]')?.addEventListener('click', () => {
      if (!answers[scenario.id]) return;
      if (index === scenarios.length - 1) renderSummary();
      else {
        index += 1;
        renderScenario();
      }
    });
  }

  function renderSummary() {
    const complete = scenarios.every((scenario) => ['same', 'new'].includes(answers[scenario.id]));
    if (!complete) {
      index = Math.max(0, scenarios.findIndex((scenario) => !answers[scenario.id]));
      renderScenario();
      return;
    }
    const rows = scenarios.map((scenario, position) => `
      <div class="answer-row">
        <strong>${position + 1}</strong>
        <span>${escapeHtml(scenario.title)}</span>
        <span class="answer-decision">${answers[scenario.id] === 'same' ? 'Dieselbe Situation' : 'Neue Situation'}</span>
      </div>`).join('');
    card.innerHTML = `
      <section class="summary">
        <div class="eyebrow">Alle zehn beantwortet</div>
        <h2>Passt deine Einteilung so?</h2>
        <p>Du kannst noch zurückgehen und Antworten ändern. Erst mit „Speichern“ werden deine Entscheidungen übernommen.</p>
        <div class="answer-summary">${rows}</div>
        <label class="note-label">
          Eigene Regel – optional
          <span>Wenn du magst: Woran merkst du persönlich, dass eine Situation vorbei ist und eine neue beginnt?</span>
          <textarea id="quiz-note" maxlength="1000" placeholder="Optional …"></textarea>
        </label>
        <button type="button" class="submit-button" id="submit-quiz">Antworten speichern</button>
        <button type="button" class="done-button" id="edit-quiz">Zurück zu den Fragen</button>
        <div class="submit-status" id="submit-status"></div>
      </section>`;

    document.getElementById('edit-quiz').addEventListener('click', () => {
      index = scenarios.length - 1;
      renderScenario();
    });
    document.getElementById('submit-quiz').addEventListener('click', submitQuiz);
  }

  async function submitQuiz() {
    const button = document.getElementById('submit-quiz');
    const status = document.getElementById('submit-status');
    button.disabled = true;
    status.className = 'submit-status';
    status.textContent = 'Antworten werden gespeichert …';
    const payload = scenarios.map((scenario) => ({
      scenarioId: scenario.id,
      decision: answers[scenario.id],
    }));
    try {
      const response = await fetch('/api/situation-quiz/submit', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          answers: payload,
          note: document.getElementById('quiz-note')?.value || '',
        }),
      });
      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || 'Speichern fehlgeschlagen.');
      localStorage.removeItem(STORAGE_KEY);
      renderDone();
    } catch (caught) {
      status.className = 'submit-status error';
      status.textContent = caught?.message || 'Die Antworten konnten nicht gespeichert werden.';
      button.disabled = false;
    }
  }

  function renderDone() {
    card.innerHTML = `
      <section class="done">
        <div class="done-mark">✓</div>
        <h2>Danke, gespeichert.</h2>
        <p>Deine Einteilung wird nicht als richtig oder falsch bewertet. Sie hilft uns dabei, die Bedeutung von „Situation“ für TrueWords sauber festzulegen.</p>
        <button type="button" class="done-button" id="continue-review">Weiter zum Prüfstand</button>
      </section>`;
    document.getElementById('continue-review').addEventListener('click', () => {
      location.replace('/review.html');
    });
  }

  async function init() {
    try {
      const response = await fetch('/api/situation-quiz/status', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 401) {
        location.replace('/login.html');
        return;
      }
      const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      if (!response.ok) throw new Error(result.error || 'Quizstatus konnte nicht geladen werden.');
      if (result.user?.role !== 'Lena') {
        location.replace(result.user?.role === 'Philipp' ? '/upload.html' : '/review.html');
        return;
      }
      if (result.completed) {
        location.replace('/review.html');
        return;
      }
      renderScenario();
    } catch (caught) {
      card.innerHTML = `<div class="quiz-error">${escapeHtml(caught?.message || 'Das Quiz konnte nicht geladen werden.')}</div>`;
    }
  }

  init();
})();
