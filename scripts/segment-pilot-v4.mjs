import fs from 'node:fs';
import path from 'node:path';
import { createTest4Preselection } from '../segmentation-v4.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    result[value.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args.chat || !args.out) {
  throw new Error('Usage: node scripts/segment-pilot-v4.mjs --chat philena-chat-2026-lossless.json --out test4.json');
}

const chat = JSON.parse(fs.readFileSync(args.chat, 'utf8'));
if (!Array.isArray(chat.messages)) throw new Error('Chat messages are missing.');
const sourceSha256 = chat?.source?.sourceSha256 || chat.datasetHash;
const annotations = createTest4Preselection(chat.messages, { sourceSha256 });
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(annotations, null, 2));
console.log(JSON.stringify({
  situations: annotations.situations.length,
  assignments: Object.keys(annotations.assignments).length,
  firstEventId: annotations.testFilter.selection.firstEventId,
  lastEventId: annotations.testFilter.selection.lastEventId,
  source: annotations.preselection.source,
}, null, 2));
