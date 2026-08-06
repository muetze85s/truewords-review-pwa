import { readFile, writeFile } from 'node:fs/promises';

const path = 'review.js';
let source = await readFile(path, 'utf8');
const block = [
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
].join('\n');

const first = source.indexOf(block);
if (first < 0) throw new Error('Account timezone block not found.');
let next = source.indexOf(`\n\n${block}`, first + block.length);
while (next >= 0) {
  source = source.slice(0, next) + source.slice(next + 2 + block.length);
  next = source.indexOf(`\n\n${block}`, first + block.length);
}

const count = source.split(block).length - 1;
if (count !== 1) throw new Error(`Expected one timezone block, found ${count}.`);
await writeFile(path, source, 'utf8');
console.log('Account timezone block normalized.');
