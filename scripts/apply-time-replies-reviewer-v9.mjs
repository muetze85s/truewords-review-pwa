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

let review = await readFile('review.js', 'utf8');
review = review
  .replaceAll('state.user?.role', 'activeReviewer()')
  .replaceAll('state.user.role', 'activeReviewer()')
  .replaceAll('formatDate(first.date)', 'formatDate(first)')
  .replaceAll('formatDate(last.date)', 'formatDate(last)')
  .replaceAll('formatDate(message?.date)', 'formatDate(message)')
  .replaceAll('formatDate(messages[0].date)', 'formatDate(messages[0])')
  .replaceAll('formatDate(messages.at(-1).date)', 'formatDate(messages.at(-1))');

function replaceReview(search, replacement) {
  if (!review.includes(search)) {
    if (review.includes(replacement)) return;
    throw new Error('Expected review.js block not found.');
  }
  review = review.replace(search, replacement);
}

replaceReview(
  "  const SHOW_COMPLETED_KEY = 'truewords-review/show-completed';",
  "  const SHOW_COMPLETED_KEY = 'truewords-review/show-completed';\n  const REVIEWER_MODE_KEY = 'truewords-review/reviewer-mode';\n  const THAILAND_TIME_ZONE = 'Asia/Bangkok';",
);

replaceReview(
  `    annotations: null,\n    messages: [],\n    selectedId: null,`,
  `    annotations: null,\n    messages: [],\n    replyMessages: new Map(),\n    reviewerMode: null,\n    selectedId: null,`,
);

replaceReview(
  `  function isOwnMessage(message) {\n    const name = speaker(message).toLocaleLowerCase('de-DE');\n    return activeReviewer() === 'Lena' ? name.includes('lena') : name.includes('philipp');\n  }\n\n  function formatDate(value) {\n    const date = new Date(value);\n    if (Number.isNaN(date.getTime())) return String(value || '');\n    return new Intl.DateTimeFormat('de-DE', {\n      day: '2-digit',\n      month: '2-digit',\n      year: '2-digit',\n      hour: '2-digit',\n      minute: '2-digit',\n    }).format(date);\n  }`,
  `  function activeReviewer() {\n    return state.reviewerMode || state.user?.role || 'Philipp';\n  }\n\n  function canSwitchReviewer() {\n    return Boolean(state.user?.canUpload);\n  }\n\n  function isOwnMessage(message) {\n    const name = speaker(message).toLocaleLowerCase('de-DE');\n    return activeReviewer() === 'Lena' ? name.includes('lena') : name.includes('philipp');\n  }\n\n  function messageDate(value) {\n    if (value && typeof value === 'object') {\n      const unix = Number(value.date_unixtime);\n      if (Number.isFinite(unix) && unix > 0) return new Date(unix * 1000);\n      return new Date(String(value.date || ''));\n    }\n    return new Date(value);\n  }\n\n  function formatDate(value) {\n    const date = messageDate(value);\n    if (Number.isNaN(date.getTime())) {\n      return typeof value === 'object' ? String(value?.date || '') : String(value || '');\n    }\n    return new Intl.DateTimeFormat('de-DE', {\n      timeZone: THAILAND_TIME_ZONE,\n      day: '2-digit',\n      month: '2-digit',\n      year: '2-digit',\n      hour: '2-digit',\n      minute: '2-digit',\n    }).format(date);\n  }`,
);

replaceReview(
  `  function messageCard(message, context = false, index = 0, total = 0) {\n    const text = textValue(message?.text) || \`[\${message?.media_type || message?.file || 'Nachricht ohne Text'}]\`;\n    const membership = context\n      ? '<span class="context-badge">Nur Kontext</span>'\n      : \`<span class="membership-badge">Teil der Situation · \${index}/\${total}</span>\`;\n    return \`\n      <article class="message \${isOwnMessage(message) ? 'mine' : ''} \${context ? 'context' : 'assigned'}"\n        data-message-id="\${escapeHtml(messageId(message))}">\n        <div class="message-meta">\n          <strong>\${escapeHtml(speaker(message))}</strong>\n          <span>\${escapeHtml(formatDate(message))}</span>\n          <span>ID \${escapeHtml(messageId(message))}</span>\n          \${membership}\n        </div>\n        <div class="message-text">\${escapeHtml(text)}</div>\n      </article>\`;\n  }`,
  `  function replyId(message) {\n    const value = Number(message?.reply_to_message_id || 0);\n    return Number.isInteger(value) && value > 0 ? String(value) : '';\n  }\n\n  function findReplyMessage(id) {\n    if (!id) return null;\n    return state.messages.find((message) => messageId(message) === String(id))\n      || state.replyMessages.get(String(id))\n      || null;\n  }\n\n  function replyPreview(message) {\n    const id = replyId(message);\n    if (!id) return '';\n    const original = findReplyMessage(id);\n    if (!original) {\n      return \`\n        <div class="reply-preview missing">\n          <div class="reply-title">Antwort auf Nachricht ID \${escapeHtml(id)}</div>\n          <div class="reply-missing">Originalnachricht im bereinigten Chat nicht verfügbar – vermutlich Medium ohne Text oder bereits herausgefilterter Inhalt.</div>\n        </div>\`;\n    }\n    const originalText = textValue(original?.text)\n      || \`[\${original?.media_type || original?.file || 'Nachricht ohne Text'}]\`;\n    return \`\n      <div class="reply-preview">\n        <div class="reply-title">Antwort auf ursprüngliche Nachricht</div>\n        <div class="reply-meta">\${escapeHtml(speaker(original))} · \${escapeHtml(formatDate(original))} · ID \${escapeHtml(id)}</div>\n        <div class="reply-text">\${escapeHtml(short(originalText, 260))}</div>\n      </div>\`;\n  }\n\n  function messageCard(message, context = false, index = 0, total = 0) {\n    const text = textValue(message?.text) || \`[\${message?.media_type || message?.file || 'Nachricht ohne Text'}]\`;\n    const membership = context\n      ? '<span class="context-badge">Nur Kontext</span>'\n      : \`<span class="membership-badge">Teil der Situation · \${index}/\${total}</span>\`;\n    return \`\n      <article class="message \${isOwnMessage(message) ? 'mine' : ''} \${context ? 'context' : 'assigned'}"\n        data-message-id="\${escapeHtml(messageId(message))}">\n        <div class="message-meta">\n          <strong>\${escapeHtml(speaker(message))}</strong>\n          <span>\${escapeHtml(formatDate(message))}</span>\n          <span>ID \${escapeHtml(messageId(message))}</span>\n          \${membership}\n        </div>\n        \${replyPreview(message)}\n        <div class="message-text">\${escapeHtml(text)}</div>\n      </article>\`;\n  }`,
);

replaceReview(
  `  function ownerStats() {\n    const result = {\n      Philipp: { situations: 0, messages: 0, done: 0 },\n      Lena: { situations: 0, messages: 0, done: 0 },\n    };\n    situations().forEach((item) => {\n      const assignedOwner = owner(item.id);\n      if (!result[assignedOwner]) return;\n      result[assignedOwner].situations += 1;\n      result[assignedOwner].messages += situationMessages(item.id).length;\n      if (isDone(item)) result[assignedOwner].done += 1;\n    });\n    return result;\n  }`,
  `  function ownerStats() {\n    const result = {\n      Philipp: { situations: 0, messages: 0, done: 0 },\n      Lena: { situations: 0, messages: 0, done: 0 },\n    };\n    situations().forEach((item) => {\n      const assignedOwner = owner(item.id);\n      if (!result[assignedOwner]) return;\n      result[assignedOwner].situations += 1;\n      result[assignedOwner].messages += situationMessages(item.id).length;\n      if (isDone(item)) result[assignedOwner].done += 1;\n    });\n    return result;\n  }\n\n  function reviewerControl() {\n    const current = activeReviewer();\n    if (!canSwitchReviewer()) {\n      return \`<div class="reviewer-fixed">Prüft als <strong>\${escapeHtml(current)}</strong></div>\`;\n    }\n    return \`\n      <div class="reviewer-switch" role="group" aria-label="Aktiven Prüfer wählen">\n        <span>Prüft als</span>\n        <button type="button" data-reviewer-mode="Philipp" class="\${current === 'Philipp' ? 'active' : ''}">Philipp</button>\n        <button type="button" data-reviewer-mode="Lena" class="\${current === 'Lena' ? 'active' : ''}">Lena</button>\n      </div>\`;\n  }`,
);

replaceReview(
  `          <nav class="account-nav">\n            <span class="account-email">\${escapeHtml(state.user.email)}</span>`,
  `          <nav class="account-nav">\n            \${reviewerControl()}\n            <span class="account-email">\${escapeHtml(state.user.email)}</span>`,
);

replaceReview(
  `          <span><strong>\${escapeHtml(state.dataset.name)}</strong> · \${open.length} offen / \${situations().length} gesamt</span>`,
  `          <span><strong>\${escapeHtml(state.dataset.name)}</strong> · \${open.length} offen / \${situations().length} gesamt</span>\n          <span class="timezone-note">Zeitangaben: Thailand · UTC+7</span>`,
);

replaceReview(
  `  function bindWorkspace() {\n    document.getElementById('logout')?.addEventListener('click', signOut);`,
  `  function bindWorkspace() {\n    document.getElementById('logout')?.addEventListener('click', signOut);\n    document.querySelectorAll('[data-reviewer-mode]').forEach((button) => {\n      button.addEventListener('click', () => {\n        const mode = button.dataset.reviewerMode;\n        if (!canSwitchReviewer() || !['Philipp', 'Lena'].includes(mode) || mode === activeReviewer()) return;\n        if (state.dirty) {\n          alert('Bitte die aktuelle Grenzänderung zuerst bestätigen, bevor der Prüfer gewechselt wird.');\n          return;\n        }\n        state.reviewerMode = mode;\n        sessionStorage.setItem(REVIEWER_MODE_KEY, mode);\n        state.selectedId = firstOwnSelection();\n        state.scrollTarget = null;\n        renderWorkspace();\n      });\n    });`,
);

replaceReview(
  `        headers: { 'content-type': 'application/json' },`,
  `        headers: {\n          'content-type': 'application/json',\n          'x-truewords-reviewer': activeReviewer(),\n        },`,
);

replaceReview(
  `      state.user = result.user;\n      state.dataset = result.dataset;\n      state.owners = result.owners || {};\n      state.annotations = result.annotations;\n      state.messages = result.messages || [];\n      state.selectedId = firstOwnSelection();`,
  `      state.user = result.user;\n      state.dataset = result.dataset;\n      state.owners = result.owners || {};\n      state.annotations = result.annotations;\n      state.messages = result.messages || [];\n      state.replyMessages = new Map(\n        (result.replyMessages || []).map((message) => [messageId(message), message]),\n      );\n      const storedReviewer = sessionStorage.getItem(REVIEWER_MODE_KEY);\n      state.reviewerMode = result.user.canUpload && ['Philipp', 'Lena'].includes(storedReviewer)\n        ? storedReviewer\n        : result.user.role;\n      state.selectedId = firstOwnSelection();`,
);

await writeFile('review.js', review, 'utf8');

await replaceRequired(
  'src/worker-portal.ts',
  `  const pathname = new URL(request.url).pathname;\n  let secret: string | undefined;\n  if (pathname.startsWith('/api/admin/')) {\n    if (!user.canUpload) return error('Nur Philipp darf Daten hochladen.', 403);\n    secret = env.ADMIN_REVIEW_TOKEN;\n  } else {\n    secret = user.role === 'Lena' ? env.LENA_REVIEW_TOKEN : env.PHILIPP_REVIEW_TOKEN;\n  }\n  if (!secret) return error('Serverzugang ist nicht vollständig konfiguriert.', 503);\n\n  const headers = new Headers(request.headers);\n  headers.set('authorization', \`Bearer \${secret}\`);\n  return new Request(request, { headers });`,
  `  const pathname = new URL(request.url).pathname;\n  let secret: string | undefined;\n  let actingReviewer: Role = user.role;\n  const requestedReviewer = request.headers.get('x-truewords-reviewer');\n  if (requestedReviewer === 'Philipp' || requestedReviewer === 'Lena') {\n    if (requestedReviewer !== user.role && !user.canUpload) {\n      return error('Dieses Konto darf den Prüfer nicht wechseln.', 403);\n    }\n    actingReviewer = requestedReviewer;\n  }\n\n  if (pathname.startsWith('/api/admin/')) {\n    if (!user.canUpload) return error('Nur Philipp darf Daten hochladen.', 403);\n    secret = env.ADMIN_REVIEW_TOKEN;\n  } else {\n    secret = actingReviewer === 'Lena' ? env.LENA_REVIEW_TOKEN : env.PHILIPP_REVIEW_TOKEN;\n  }\n  if (!secret) return error('Serverzugang ist nicht vollständig konfiguriert.', 503);\n\n  const headers = new Headers(request.headers);\n  headers.delete('x-truewords-reviewer');\n  headers.set('authorization', \`Bearer \${secret}\`);\n  return new Request(request, { headers });`,
);

await replaceRequired(
  'src/worker-review.ts',
  `function sourceId(message: unknown): string {\n  if (!message || typeof message !== 'object') return '';\n  const id = (message as { id?: unknown }).id;\n  return id === undefined || id === null ? '' : String(id);\n}\n\nasync function reviewWindow`,
  `function sourceId(message: unknown): string {\n  if (!message || typeof message !== 'object') return '';\n  const id = (message as { id?: unknown }).id;\n  return id === undefined || id === null ? '' : String(id);\n}\n\nfunction replySourceId(message: unknown): number | null {\n  if (!message || typeof message !== 'object') return null;\n  const id = Number((message as { reply_to_message_id?: unknown }).reply_to_message_id || 0);\n  return Number.isInteger(id) && id > 0 ? id : null;\n}\n\nasync function additionalReplyMessages(\n  env: Env,\n  dataset: DatasetRow,\n  messages: unknown[],\n): Promise<unknown[]> {\n  const available = new Set(messages.map(sourceId).filter(Boolean));\n  const requested = [...new Set(\n    messages\n      .map(replySourceId)\n      .filter((id): id is number => id !== null)\n      .filter((id) => !available.has(String(id))),\n  )].slice(0, 80);\n  if (!requested.length) return [];\n\n  const conditions = requested\n    .map((_, index) => \`instr(messages_json, ?\${index + 2}) > 0\`)\n    .join(' OR ');\n  const needles = requested.map((id) => \`\\\"id\\\":\${id}\`);\n  const rows = await env.DB.prepare(\`\n    SELECT chunk_index, messages_json\n    FROM review_chat_chunks\n    WHERE dataset_id = ?1 AND (\${conditions})\n    ORDER BY chunk_index\n  \`).bind(dataset.id, ...needles).all<ChatChunkRow>();\n\n  const wanted = new Set(requested.map(String));\n  const found = new Map<string, unknown>();\n  for (const row of rows.results || []) {\n    const parsed = JSON.parse(row.messages_json);\n    if (!Array.isArray(parsed)) continue;\n    for (const message of parsed) {\n      const id = sourceId(message);\n      if (wanted.has(id) && !found.has(id)) found.set(id, message);\n    }\n  }\n  return [...found.values()];\n}\n\nasync function reviewWindow`,
);

await replaceRequired(
  'src/worker-review.ts',
  `  const messages = await reviewWindow(env, dataset, annotations);\n  return json({`,
  `  const messages = await reviewWindow(env, dataset, annotations);\n  const replyMessages = await additionalReplyMessages(env, dataset, messages);\n  return json({`,
);

await replaceRequired(
  'src/worker-review.ts',
  `    annotations,\n    messages,\n    window: {`,
  `    annotations,\n    messages,\n    replyMessages,\n    window: {`,
);

let css = await readFile('review.css', 'utf8');
const extraCss = `

/* Thailand time, reply previews and reviewer switching */
.reviewer-switch,
.reviewer-fixed {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border: 1px solid #344763;
  border-radius: 999px;
  background: #0e192a;
  color: var(--muted);
  font-size: 10px;
  white-space: nowrap;
}
.reviewer-switch button {
  padding: 5px 8px;
  border-radius: 999px;
  background: transparent;
  font-size: 10px;
}
.reviewer-switch button.active {
  border-color: #63a5f2;
  background: #1f5fae;
  color: #fff;
  font-weight: 900;
}
.reviewer-fixed strong { color: var(--text); }
.timezone-note {
  color: #b8d8ff;
  font-weight: 800;
  white-space: nowrap;
}
.reply-preview {
  margin: 3px 0 9px;
  padding: 8px 10px;
  border-left: 4px solid #7bb8ff;
  border-radius: 8px;
  background: #09182a;
  box-shadow: inset 0 0 0 1px #33547c;
}
.reply-preview.missing {
  border-left-color: var(--warn);
  background: #251f12;
  box-shadow: inset 0 0 0 1px #665424;
}
.reply-title {
  margin-bottom: 3px;
  color: #cfe5ff;
  font-size: 10px;
  font-weight: 900;
  text-transform: uppercase;
  letter-spacing: .05em;
}
.reply-meta {
  margin-bottom: 4px;
  color: #9eb7d8;
  font-size: 10px;
}
.reply-text,
.reply-missing {
  color: #dbe9fb;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.reply-missing { color: #f3d994; }

@media (max-width: 900px) {
  .reviewer-switch > span { display: none; }
}

@media (max-width: 680px) {
  .account-nav { flex-wrap: wrap; justify-content: flex-end; }
  .reviewer-switch,
  .reviewer-fixed { order: 3; }
  .timezone-note { white-space: normal; }
}
`;
if (!css.includes('/* Thailand time, reply previews and reviewer switching */')) {
  css = `${css.trimEnd()}${extraCss}`;
  await writeFile('review.css', css, 'utf8');
}

await replaceRequired(
  'review.html',
  '<link rel="stylesheet" href="./review.css?v=8">',
  '<link rel="stylesheet" href="./review.css?v=9">',
);
await replaceRequired(
  'review.html',
  '<script src="./review.js?v=8"></script>',
  '<script src="./review.js?v=9"></script>',
);
await replaceRequired(
  'sw.js',
  "const CACHE = 'truewords-review-pwa-server-v7';",
  "const CACHE = 'truewords-review-pwa-server-v8';",
);

console.log('Thailand time, reply preview and reviewer switching v9 applied.');
