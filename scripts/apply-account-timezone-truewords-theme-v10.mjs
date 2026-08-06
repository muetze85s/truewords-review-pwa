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
  "  const THAILAND_TIME_ZONE = 'Asia/Bangkok';",
  `  const ACCOUNT_TIME_ZONES = {\n    Philipp: { zone: 'Asia/Bangkok', label: 'Thailand' },\n    Lena: { zone: 'Europe/Berlin', label: 'Deutschland' },\n  };`,
);

await replaceRequired(
  'review.js',
  `  function canSwitchReviewer() {\n    return Boolean(state.user?.canUpload);\n  }`,
  `  function canSwitchReviewer() {\n    return Boolean(state.user?.canUpload);\n  }\n\n  function accountTimeZone() {\n    return ACCOUNT_TIME_ZONES[state.user?.role]?.zone\n      || Intl.DateTimeFormat().resolvedOptions().timeZone\n      || 'UTC';\n  }\n\n  function accountTimeLabel() {\n    const configured = ACCOUNT_TIME_ZONES[state.user?.role];\n    if (configured) return \`${configured.label} · ${configured.zone}\`;\n    return accountTimeZone();\n  }`,
);

await replaceRequired(
  'review.js',
  `      timeZone: THAILAND_TIME_ZONE,`,
  `      timeZone: accountTimeZone(),`,
);

await replaceRequired(
  'review.js',
  `<div class="logo">TW</div>\n            <div><div class="eyebrow">Gemeinsame Prüf-PWA</div><h1>Situationen prüfen</h1></div>`,
  `<div class="logo" aria-label="TrueWords"><i></i><b></b></div>\n            <div><div class="eyebrow">TrueWords · Gemeinsame Prüfung</div><h1>Situationen prüfen</h1></div>`,
);

await replaceRequired(
  'review.js',
  `<span class="timezone-note">Zeitangaben: Thailand · UTC+7</span>`,
  `<span class="timezone-note">Zeitangaben: ${escapeHtml(accountTimeLabel())}</span>`,
);

const themeCss = `

/* TrueWords product theme */
:root {
  color-scheme: light;
  --bg: #f6f2ec;
  --panel: #fffdf9;
  --panel-2: #f8f6f2;
  --line: #ded9d1;
  --text: #17201e;
  --muted: #68716d;
  --accent: #087c70;
  --good: #087c70;
  --warn: #c58b26;
  --bad: #d75467;
  --corrected: #76669a;
  --teal: #087c70;
  --teal-dark: #075e57;
  --teal-soft: #def0eb;
  --rose: #d75467;
  --rose-soft: #f9e3e6;
  --ink: #17201e;
  --paper: #f6f2ec;
  --card: #fffdf9;
  --shadow: 0 18px 60px rgba(34, 45, 42, .08);
}

html { background: var(--paper); color: var(--ink); }
body {
  background:
    radial-gradient(circle at 85% 5%, rgba(8, 124, 112, .08), transparent 30rem),
    radial-gradient(circle at 7% 94%, rgba(215, 84, 103, .07), transparent 28rem),
    var(--paper);
  color: var(--ink);
  font-family: Manrope, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

button, a.button {
  border-color: var(--line);
  border-radius: .85rem;
  background: #fff;
  color: var(--ink);
  font-weight: 800;
  transition: .16s;
}
button:hover:not(:disabled), a.button:hover {
  border-color: #84c3b8;
  transform: translateY(-1px);
}
button:focus-visible, a:focus-visible {
  outline: 3px solid rgba(8, 124, 112, .25);
  outline-offset: 2px;
}
button.primary, button.confirm {
  border-color: transparent;
  background: var(--teal);
  color: #fff;
  box-shadow: 0 9px 25px rgba(8, 124, 112, .2);
}
button.primary:hover, button.confirm:hover:not(:disabled) { background: var(--teal-dark); }
button.secondary { background: #fff; }

.loading-screen { background: transparent; }
.loading-card {
  border-color: rgba(222, 217, 209, .9);
  border-radius: 1.5rem;
  background: rgba(255, 253, 249, .95);
  box-shadow: var(--shadow);
}
.loading-card h1 { color: var(--ink); letter-spacing: -.04em; }
.loading-mark,
.logo {
  position: relative;
  overflow: hidden;
  border-radius: .82rem;
  background: var(--ink);
  box-shadow: 0 7px 18px rgba(23, 32, 30, .18);
  color: transparent;
}
.logo {
  width: 2.4rem;
  height: 2.4rem;
  flex: 0 0 2.4rem;
}
.loading-mark { width: 3.25rem; height: 3.25rem; }
.logo i, .logo b,
.loading-mark i, .loading-mark b {
  position: absolute;
  display: block;
  border-radius: .55rem;
}
.logo i, .logo b { width: 1.38rem; height: .92rem; }
.logo i { top: .55rem; left: .4rem; background: #2ca99d; }
.logo b { right: .38rem; bottom: .48rem; background: #ec6d7d; }
.loading-mark i, .loading-mark b { width: 1.85rem; height: 1.18rem; }
.loading-mark i { top: .68rem; left: .5rem; background: #2ca99d; }
.loading-mark b { right: .48rem; bottom: .62rem; background: #ec6d7d; }
.logo i::after, .logo b::after,
.loading-mark i::after, .loading-mark b::after {
  position: absolute;
  bottom: -.24rem;
  width: 0;
  height: 0;
  border-style: solid;
  content: "";
}
.logo i::after, .loading-mark i::after {
  left: .2rem;
  border-width: .3rem .35rem 0 0;
  border-color: #2ca99d transparent transparent;
}
.logo b::after, .loading-mark b::after {
  right: .2rem;
  border-width: .3rem 0 0 .35rem;
  border-color: #ec6d7d transparent transparent;
}
.loading-bar { background: #ece8e1; }
.loading-bar span { background: var(--teal); }

.topbar {
  border-bottom-color: rgba(222, 217, 209, .78);
  background: rgba(246, 242, 236, .9);
  box-shadow: 0 7px 24px rgba(34, 45, 42, .05);
}
.brand h1 {
  color: var(--ink);
  font-size: 1.18rem;
  font-weight: 760;
  letter-spacing: -.035em;
}
.eyebrow { color: var(--teal); font-weight: 900; }
.account-nav button,
.account-nav a.button {
  background: rgba(255, 253, 249, .95);
}

.summarybar {
  border-bottom-color: var(--line);
  background: rgba(255, 253, 249, .78);
  color: var(--muted);
}
.summarybar strong { color: var(--ink); }
.timezone-note {
  padding: .32rem .55rem;
  border-radius: 999px;
  background: var(--teal-soft);
  color: var(--teal-dark);
  font-size: .66rem;
}
.sync-status[data-state="ok"] { color: var(--teal-dark); }
.sync-status[data-state="working"] { color: #765519; }
.sync-status[data-state="error"] { color: #9c3544; }

.panel {
  border-color: rgba(222, 217, 209, .9);
  background: rgba(255, 253, 249, .94);
  box-shadow: var(--shadow);
}
.panel-head,
.list-controls,
.list-legend,
.chat-head,
.boundary-box,
.review-actions { border-color: var(--line); }
.list-controls,
.boundary-box,
.review-actions { background: #f8f6f2; }
.count-pill {
  background: var(--teal-soft);
  color: var(--teal-dark);
  font-weight: 900;
}

.situation-row { border-bottom-color: var(--line); }
.situation-row:hover { background: #f8f6f2; }
.situation-row.active {
  background: var(--teal-soft);
  box-shadow: inset 0 0 0 1px #9bcfc5;
}
.situation-row.other-owner { opacity: .62; }
.situation-row.status-open { border-left-color: var(--warn); }
.situation-row.status-confirmed { border-left-color: var(--teal); }
.situation-row.status-corrected { border-left-color: var(--corrected); }
.situation-row.status-unclear { border-left-color: var(--rose); }
.situation-check {
  border-color: #aaa39a;
  background: #fff;
  color: var(--ink);
}
.situation-check:not(:disabled):hover {
  border-color: var(--teal);
  background: var(--teal-soft);
}
.situation-check.done {
  border-color: var(--teal);
  background: var(--teal);
  color: #fff;
}
.situation-check.changed {
  border-color: var(--corrected);
  box-shadow: 0 0 0 3px rgba(118, 102, 154, .14);
}
.situation-title { color: var(--ink); }
.owner-badge, .status-badge {
  background: #efede9;
  color: #4a5551;
}
.owner-badge.mine {
  background: var(--teal-soft);
  color: var(--teal-dark);
}

.chat-head h2 {
  color: var(--ink);
  font-weight: 760;
  letter-spacing: -.035em;
}
.message-list { background: #f3efe9; }
.context-zone {
  border-color: #bcb5ab;
  background: rgba(255, 253, 249, .64);
}
.context-zone .context-label { color: #7d7770; }
.situation-zone {
  border-color: var(--teal);
  background: #f4faf8;
  box-shadow: 0 0 0 4px rgba(8, 124, 112, .08), 0 16px 36px rgba(34, 45, 42, .08);
}
.situation-boundary {
  background: var(--teal);
  color: #fff;
}
.situation-boundary.end {
  border-top-color: #ef9eaa;
  background: var(--rose);
  color: #fff;
}
.situation-zone .message.assigned {
  border-color: #e3c2c7;
  background: var(--rose-soft);
  box-shadow: 0 3px 10px rgba(34, 45, 42, .07);
}
.situation-zone .message.assigned.mine {
  border-color: #9bcfc5;
  background: var(--teal-soft);
}
.message-meta { color: var(--muted); }
.message-meta strong { color: var(--ink); }
.membership-badge {
  background: var(--teal);
  color: #fff;
}
.context-badge {
  border-color: #c9c3ba;
  background: #efede9;
  color: #746f69;
}
.context-zone .message.context,
.context-zone .message.context.mine {
  border-color: #c9c3ba;
  background: #fffdf9;
  filter: saturate(.5);
}
.message.boundary-focus {
  border-color: var(--rose);
  box-shadow: 0 0 0 4px rgba(215, 84, 103, .18);
}

.reply-preview {
  border-left-color: var(--teal);
  background: #fffdf9;
  box-shadow: inset 0 0 0 1px #bddbd5;
}
.reply-preview.missing {
  border-left-color: var(--warn);
  background: #fff9ed;
  box-shadow: inset 0 0 0 1px #e0c28d;
}
.reply-title { color: var(--teal-dark); }
.reply-meta { color: var(--muted); }
.reply-text { color: var(--ink); }
.reply-missing { color: #765519; }

.reviewer-switch,
.reviewer-fixed {
  border-color: var(--line);
  background: rgba(255, 253, 249, .95);
  color: var(--muted);
}
.reviewer-switch button { background: transparent; }
.reviewer-switch button.active {
  border-color: transparent;
  background: var(--ink);
  color: #fff;
}
.reviewer-fixed strong { color: var(--ink); }
.review-note { color: var(--muted); }

.error-card {
  border-color: #e7a5af;
  background: var(--rose-soft);
  color: var(--ink);
  box-shadow: var(--shadow);
}
.error-card p { color: #81313e; }

@media (max-width: 680px) {
  .review-grid { gap: 10px; }
  .situation-panel { box-shadow: 0 10px 30px rgba(34, 45, 42, .07); }
}
`;

const css = await readFile('review.css', 'utf8');
if (!css.includes('/* TrueWords product theme */')) {
  await writeFile('review.css', `${css.trimEnd()}${themeCss}`, 'utf8');
}

for (const path of ['review.html', 'login.html', 'upload.html', 'account-setup.html']) {
  await replaceRequired(path, '<meta name="theme-color" content="#08101c">', '<meta name="theme-color" content="#f6f2ec">')
    .catch(async () => replaceRequired(path, '<meta name="theme-color" content="#0b1220">', '<meta name="theme-color" content="#f6f2ec">'));
}

await replaceRequired(
  'review.html',
  '<div class="loading-mark">TW</div>',
  '<div class="loading-mark" aria-label="TrueWords"><i></i><b></b></div>',
);
await replaceRequired('review.html', './review.css?v=9', './review.css?v=10');
await replaceRequired('review.html', './review.js?v=9', './review.js?v=10');

const brand = `<div class="portal-brand">\n        <span class="truewords-logo" aria-hidden="true"><i></i><b></b></span>\n        <span><strong>TrueWords</strong><small>Gemeinsame Prüfung</small></span>\n      </div>`;
for (const path of ['login.html', 'account-setup.html']) {
  await replaceRequired(
    path,
    '      <div class="eyebrow">',
    `      ${brand}\n      <div class="eyebrow">`,
  );
}
await replaceRequired(
  'upload.html',
  '      <section class="card">\n        <div class="header">',
  `      <section class="card">\n        ${brand}\n        <div class="header">`,
);

await replaceRequired(
  'sw.js',
  "const CACHE = 'truewords-review-pwa-server-v8';",
  "const CACHE = 'truewords-review-pwa-server-v9';",
);

console.log('Account timezone and TrueWords theme v10 applied.');
