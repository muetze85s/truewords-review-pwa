(() => {
  'use strict';

  // Rendert docs/CODEBOOK.md (als Asset /CODEBOOK.md ausgeliefert) zu HTML —
  // einzige Quelle, damit die Nachschlage-Seite exakt dieselben Definitionen
  // zeigt wie Tooltips und (später) LLM-Prompt. Bewusst minimaler Markdown-
  // Renderer ohne externe Bibliothek: Überschriften, Listen, fett/kursiv,
  // Inline-Code, Trennlinien, Absätze — mehr braucht das Handbuch nicht.

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, (char) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
    ));
  }

  // Inline: **fett**, *kursiv*, `code` — auf bereits escaptem Text.
  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/gu, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>');
    return out;
  }

  function render(markdown) {
    const lines = markdown.replace(/\r\n/gu, '\n').split('\n');
    const parts = [];
    let listOpen = false;
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length) {
        parts.push(`<p>${inline(paragraph.join(' '))}</p>`);
        paragraph = [];
      }
    }
    function closeList() {
      if (listOpen) { parts.push('</ul>'); listOpen = false; }
    }

    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushParagraph(); closeList(); continue; }

      const heading = line.match(/^(#{1,6})\s+(.*)$/u);
      if (heading) {
        flushParagraph(); closeList();
        const level = heading[1].length;
        parts.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
      if (/^---+$/u.test(line.trim())) {
        flushParagraph(); closeList();
        parts.push('<hr>');
        continue;
      }
      const bullet = line.match(/^\s*[-*]\s+(.*)$/u);
      if (bullet) {
        flushParagraph();
        if (!listOpen) { parts.push('<ul>'); listOpen = true; }
        parts.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      // sonst Absatztext
      closeList();
      paragraph.push(line.trim());
    }
    flushParagraph(); closeList();
    return parts.join('\n');
  }

  fetch('/CODEBOOK.md', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then((markdown) => {
      const container = document.getElementById('cb-content');
      container.innerHTML = render(markdown);
      const version = markdown.match(/Kodierhandbuchversion:\s*(\d+)/u);
      if (version) {
        const badge = document.getElementById('cb-version');
        if (badge) badge.textContent = `Handbuchversion ${version[1]}`;
      }
    })
    .catch((caught) => {
      const container = document.getElementById('cb-content');
      if (container) container.innerHTML = `<p class="dp-status error">Konnte das Kodierhandbuch nicht laden: ${escapeHtml(caught.message)}</p>`;
    });
})();
