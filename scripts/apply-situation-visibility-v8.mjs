import { readFile, writeFile } from 'node:fs/promises';

async function replaceRequired(path, search, replacement) {
  const source = await readFile(path, 'utf8');
  if (!source.includes(search)) {
    if (source.includes(replacement)) return false;
    throw new Error(`Expected block not found in ${path}`);
  }
  await writeFile(path, source.replace(search, replacement), 'utf8');
  return true;
}

await replaceRequired(
  'review.js',
  `  function messageCard(message, context = false) {\n    const text = textValue(message?.text) || \`[\${message?.media_type || message?.file || 'Nachricht ohne Text'}]\`;\n    return \`\n      <article class="message \${isOwnMessage(message) ? 'mine' : ''} \${context ? 'context' : ''}"\n        data-message-id="\${escapeHtml(messageId(message))}">\n        <div class="message-meta">\n          <strong>\${escapeHtml(speaker(message))}</strong>\n          <span>\${escapeHtml(formatDate(message?.date))}</span>\n          <span>ID \${escapeHtml(messageId(message))}</span>\n        </div>\n        <div class="message-text">\${escapeHtml(text)}</div>\n      </article>\`;\n  }`,
  `  function messageCard(message, context = false, index = 0, total = 0) {\n    const text = textValue(message?.text) || \`[\${message?.media_type || message?.file || 'Nachricht ohne Text'}]\`;\n    const membership = context\n      ? '<span class="context-badge">Nur Kontext</span>'\n      : \`<span class="membership-badge">Teil der Situation · \${index}/\${total}</span>\`;\n    return \`\n      <article class="message \${isOwnMessage(message) ? 'mine' : ''} \${context ? 'context' : 'assigned'}"\n        data-message-id="\${escapeHtml(messageId(message))}">\n        <div class="message-meta">\n          <strong>\${escapeHtml(speaker(message))}</strong>\n          <span>\${escapeHtml(formatDate(message?.date))}</span>\n          <span>ID \${escapeHtml(messageId(message))}</span>\n          \${membership}\n        </div>\n        <div class="message-text">\${escapeHtml(text)}</div>\n      </article>\`;\n  }`,
);

await replaceRequired(
  'review.js',
  `        <div class="message-list" id="message-list">\n          \${context.before ? '<div class="context-label">Nachricht davor</div>' + messageCard(context.before, true) : ''}\n          <div class="context-label">Diese Situation · \${messages.length} Nachrichten</div>\n          \${messages.length ? messages.map((message) => messageCard(message)).join('') : '<p>Dieser Situation sind keine Nachrichten zugeordnet.</p>'}\n          \${context.after ? '<div class="context-label">Nachricht danach</div>' + messageCard(context.after, true) : ''}\n        </div>`,
  `        <div class="message-list" id="message-list">\n          \${context.before ? \`\n            <section class="context-zone before" aria-label="Kontext vor der Situation">\n              <div class="context-label">Nur Kontext · Nachricht davor</div>\n              \${messageCard(context.before, true)}\n            </section>\` : ''}\n\n          <section class="situation-zone" aria-label="Nachrichten der Situation \${Number(selected.id)}">\n            <div class="situation-boundary start">\n              <span>Situation \${Number(selected.id)} beginnt</span>\n              <strong>\${messages.length} Nachrichten gehören zu dieser Situation</strong>\n            </div>\n            <div class="situation-messages">\n              \${messages.length\n                ? messages.map((message, index) => messageCard(message, false, index + 1, messages.length)).join('')\n                : '<p>Dieser Situation sind keine Nachrichten zugeordnet.</p>'}\n            </div>\n            <div class="situation-boundary end">\n              <span>Situation \${Number(selected.id)} endet</span>\n              <strong>\${messages.at(-1) ? escapeHtml(formatDate(messages.at(-1).date)) : 'ohne Nachrichten'}</strong>\n            </div>\n          </section>\n\n          \${context.after ? \`\n            <section class="context-zone after" aria-label="Kontext nach der Situation">\n              <div class="context-label">Nur Kontext · Nachricht danach</div>\n              \${messageCard(context.after, true)}\n            </section>\` : ''}\n        </div>`,
);

const css = await readFile('review.css', 'utf8');
const visibilityStyles = `

/* Situation membership visibility */
.message-list {
  background: #07111f;
}
.context-zone {
  margin: 6px 4px 14px;
  padding: 8px 10px 10px;
  border: 1px dashed #52627b;
  border-radius: 13px;
  background: #0a1320;
}
.context-zone.after { margin-top: 14px; margin-bottom: 2px; }
.context-zone .context-label {
  margin: 0 0 6px;
  color: #8493aa;
}
.situation-zone {
  position: relative;
  margin: 10px 0 14px;
  padding: 0 12px 12px;
  overflow: hidden;
  border: 2px solid #4d93e8;
  border-radius: 17px;
  background: #10243e;
  box-shadow: 0 0 0 4px #4d93e81f, 0 16px 36px #0005;
}
.situation-boundary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 -12px 10px;
  padding: 10px 12px;
  background: #1f5fae;
  color: #fff;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: .02em;
}
.situation-boundary strong {
  font-size: 11px;
  font-weight: 700;
  text-align: right;
}
.situation-boundary.end {
  margin: 12px -12px -12px;
  border-top: 1px solid #5fe0b7;
  background: #174738;
  color: #c8ffed;
}
.situation-messages {
  padding: 2px 2px 0;
}
.situation-zone .message.assigned {
  border-width: 2px;
  border-color: #496b96;
  background: #142840;
  box-shadow: 0 3px 10px #0004;
}
.situation-zone .message.assigned.mine {
  border-color: #4d93e8;
  background: #15365e;
}
.membership-badge,
.context-badge {
  margin-left: auto;
  padding: 3px 7px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: .02em;
  white-space: nowrap;
}
.membership-badge {
  background: #1f5fae;
  color: #fff;
}
.context-badge {
  border: 1px solid #59677a;
  background: #111b29;
  color: #8e9caf;
}
.context-zone .message.context {
  opacity: .48;
  filter: saturate(.55);
  border-style: dashed;
  background: #0b1420;
}
.context-zone .message.context.mine {
  background: #102239;
}

@media (max-width: 680px) {
  .situation-boundary {
    align-items: flex-start;
    flex-direction: column;
  }
  .situation-boundary strong { text-align: left; }
  .membership-badge,
  .context-badge {
    width: 100%;
    margin-left: 0;
    text-align: center;
  }
}
`;

if (!css.includes('/* Situation membership visibility */')) {
  await writeFile('review.css', `${css.trimEnd()}${visibilityStyles}`, 'utf8');
}

await replaceRequired(
  'review.html',
  '<link rel="stylesheet" href="./review.css?v=7">',
  '<link rel="stylesheet" href="./review.css?v=8">',
);
await replaceRequired(
  'review.html',
  '<script src="./review.js?v=7"></script>',
  '<script src="./review.js?v=8"></script>',
);
await replaceRequired(
  'sw.js',
  "const CACHE = 'truewords-review-pwa-server-v6';",
  "const CACHE = 'truewords-review-pwa-server-v7';",
);

console.log('Situation visibility v8 applied.');
