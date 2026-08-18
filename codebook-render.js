(() => {
  'use strict';

  // Nachschlage-Seite des Kodierhandbuchs: rendert docs/CODEBOOK.md (Asset
  // /CODEBOOK.md) übersichtlich als Karten je Klasse — Definition, Beispiel
  // (grün) und Grenzfall (rot) klar getrennt. Zusätzlich je Definition zwei
  // Freigabe-Häkchen (Philipp/Lena): bei beiden Haken gilt die Definition als
  // freigegeben (Kodierhandbuch bleibt einzige Quelle — hier nur gerendert).

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  // Inline: **fett**, *kursiv*, `code` auf bereits escaptem Text.
  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/gu, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>');
    return out;
  }

  // Zerlegt das Handbuch in Gruppen → Klassen → Felder.
  function parse(markdown) {
    const lines = markdown.replace(/\r\n/gu, '\n').split('\n');
    const groups = [];
    let group = null;
    let cls = null;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/u, '');
      const h2 = line.match(/^##\s+(.*)$/u);
      if (h2) { cls = null; group = { title: h2[1].trim(), classes: [] }; groups.push(group); continue; }
      const h3 = line.match(/^###\s+(.*)$/u);
      if (h3) {
        const m = h3[1].match(/^`([^`]+)`\s*[—-]\s*(.*)$/u);
        cls = m ? { key: m[1], label: m[2].trim(), fields: [] } : { key: null, label: h3[1].trim(), fields: [] };
        if (!group) { group = { title: '', classes: [] }; groups.push(group); }
        group.classes.push(cls);
        continue;
      }
      const field = line.match(/^\*\*(.+?):\*\*\s*(.*)$/u);
      if (field && cls) { cls.fields.push({ label: field[1].trim(), value: field[2].trim() }); }
    }
    // Nur Gruppen mit echten (Key-tragenden) Klassen.
    return groups
      .map((g) => ({ title: g.title, classes: g.classes.filter((c) => c.key) }))
      .filter((g) => g.classes.length);
  }

  function fieldKind(label) {
    if (/^Definition/u.test(label)) return 'definition';
    if (/^Beispiel/u.test(label)) return 'example';
    if (/^Grenzfall/u.test(label)) return 'boundary';
    if (/^Abgrenzung/u.test(label)) return 'delimit';
    return 'note';
  }
  function fieldLabelText(kind, raw) {
    if (kind === 'definition') return 'Definition';
    if (kind === 'example') return 'Beispiel';
    if (kind === 'boundary') return 'Zählt NICHT';
    if (kind === 'delimit') return raw.replace(/:$/u, '');
    return raw.replace(/:$/u, '');
  }

  const state = { me: '', signoffs: {}, total: 0 };

  function signFor(key) {
    return state.signoffs[key] || { Philipp: false, Lena: false };
  }

  function checkboxHtml(key, who) {
    const s = signFor(key);
    const own = who === state.me;
    return `<label class="cb-check ${own ? 'own' : 'other'}">
      <input type="checkbox" data-key="${escapeHtml(key)}" data-who="${who}" ${s[who] ? 'checked' : ''} ${own ? '' : 'disabled'}>
      <span>${who}${own ? ' (du)' : ''}</span>
    </label>`;
  }

  function classCard(cls) {
    const fields = cls.fields.map((f) => {
      const kind = fieldKind(f.label);
      return `<div class="cb-field cb-${kind}">
        <span class="cb-field-label">${escapeHtml(fieldLabelText(kind, f.label))}</span>
        <span class="cb-field-text">${inline(f.value)}</span>
      </div>`;
    }).join('');
    const s = signFor(cls.key);
    const both = s.Philipp && s.Lena;
    return `<article class="cb-card${both ? ' freigegeben' : ''}" data-key="${escapeHtml(cls.key)}">
      <header class="cb-card-head">
        <div class="cb-card-title"><span class="cb-key">${escapeHtml(cls.key)}</span><span class="cb-label">${escapeHtml(cls.label)}</span></div>
        <span class="cb-badge">${both ? 'freigegeben ✓' : ''}</span>
      </header>
      <div class="cb-fields">${fields}</div>
      <footer class="cb-signoff">
        <span class="cb-signoff-hint">Gegengelesen &amp; einverstanden:</span>
        ${checkboxHtml(cls.key, 'Philipp')}
        ${checkboxHtml(cls.key, 'Lena')}
      </footer>
    </article>`;
  }

  function updateSummary() {
    const el = document.getElementById('cb-summary');
    if (!el) return;
    let both = 0;
    for (const key of Object.keys(state.signoffs)) { const s = state.signoffs[key]; if (s.Philipp && s.Lena) both += 1; }
    el.textContent = `${both} von ${state.total} Definitionen beidseitig freigegeben.`;
  }

  function render(groups) {
    state.total = groups.reduce((sum, g) => sum + g.classes.length, 0);
    const container = document.getElementById('cb-content');
    container.innerHTML = groups.map((g) => `
      <section class="cb-group">
        <h2 class="cb-group-title">${escapeHtml(g.title)}</h2>
        ${g.classes.map(classCard).join('')}
      </section>`).join('');
    updateSummary();

    container.querySelectorAll('input[type="checkbox"]:not([disabled])').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.key;
        const agreed = input.checked;
        input.disabled = true;
        fetch('/api/classification/codebook-signoff', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ patternKey: key, agreed }),
        }).then((r) => r.json()).then((data) => {
          if (!data || !data.ok) throw new Error((data && data.error) || 'Fehler');
          if (!state.signoffs[key]) state.signoffs[key] = { Philipp: false, Lena: false };
          state.signoffs[key][state.me] = agreed;
          const card = input.closest('.cb-card');
          const s = state.signoffs[key];
          const both = s.Philipp && s.Lena;
          card.classList.toggle('freigegeben', both);
          card.querySelector('.cb-badge').textContent = both ? 'freigegeben ✓' : '';
          updateSummary();
        }).catch(() => { input.checked = !agreed; }).then(() => { input.disabled = false; });
      });
    });
  }

  Promise.all([
    fetch('/CODEBOOK.md', { credentials: 'same-origin', cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
    fetch('/api/classification/codebook-signoff', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]).then(([markdown, sign]) => {
    if (sign && sign.ok) { state.me = sign.reviewer || ''; state.signoffs = sign.signoffs || {}; }
    const versionMatch = markdown.match(/Kodierhandbuchversion:\s*(\d+)/u);
    const badge = document.getElementById('cb-version');
    if (badge && versionMatch) badge.textContent = `Handbuchversion ${versionMatch[1]}${sign && sign.version ? '' : ''}`;
    render(parse(markdown));
  }).catch((caught) => {
    const container = document.getElementById('cb-content');
    if (container) container.innerHTML = `<p class="dp-status error">Konnte das Kodierhandbuch nicht laden: ${escapeHtml(caught.message)}</p>`;
  });
})();
