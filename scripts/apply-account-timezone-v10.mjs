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
  [
    '  const ACCOUNT_TIME_ZONES = {',
    "    Philipp: { zone: 'Asia/Bangkok', label: 'Thailand' },",
    "    Lena: { zone: 'Europe/Berlin', label: 'Deutschland' },",
    '  };',
  ].join('\n'),
);

await replaceRequired(
  'review.js',
  [
    '  function canSwitchReviewer() {',
    '    return Boolean(state.user?.canUpload);',
    '  }',
  ].join('\n'),
  [
    '  function canSwitchReviewer() {',
    '    return Boolean(state.user?.canUpload);',
    '  }',
    '',
    '  function accountTimeZone() {',
    '    return ACCOUNT_TIME_ZONES[state.user?.role]?.zone',
    "      || Intl.DateTimeFormat().resolvedOptions().timeZone",
    "      || 'UTC';",
    '  }',
    '',
    '  function accountTimeLabel() {',
    '    const configured = ACCOUNT_TIME_ZONES[state.user?.role];',
    '    if (configured) return `${configured.label} · ${configured.zone}`;',
    '    return accountTimeZone();',
    '  }',
  ].join('\n'),
);

await replaceRequired(
  'review.js',
  '      timeZone: THAILAND_TIME_ZONE,',
  '      timeZone: accountTimeZone(),',
);

await replaceRequired(
  'review.js',
  '<div class="logo">TW</div>\n            <div><div class="eyebrow">Gemeinsame Prüf-PWA</div><h1>Situationen prüfen</h1></div>',
  '<div class="logo" aria-label="TrueWords"><i></i><b></b></div>\n            <div><div class="eyebrow">TrueWords · Gemeinsame Prüfung</div><h1>Situationen prüfen</h1></div>',
);

await replaceRequired(
  'review.js',
  '<span class="timezone-note">Zeitangaben: Thailand · UTC+7</span>',
  '<span class="timezone-note">Zeitangaben: ${escapeHtml(accountTimeLabel())}</span>',
);

console.log('Account timezone v10 applied.');
