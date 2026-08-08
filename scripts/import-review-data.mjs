import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [chatArgument, annotationsArgument] = process.argv.slice(2);
const apiBase = String(process.env.REVIEW_API_URL || '').replace(/\/$/, '');
const adminToken = String(process.env.ADMIN_REVIEW_TOKEN || '');
const datasetId = String(process.env.DATASET_ID || 'philena-2026');
const datasetName = String(process.env.DATASET_NAME || 'Philipp & Lena');
const year = Number(process.env.REVIEW_YEAR || 2026);

if (!chatArgument || !annotationsArgument) {
  throw new Error('Aufruf: npm run import:data -- <telegram-chat.json> <markierungen.json>');
}
if (!apiBase.startsWith('https://')) throw new Error('REVIEW_API_URL muss eine HTTPS-Adresse sein.');
if (!adminToken) throw new Error('ADMIN_REVIEW_TOKEN fehlt.');
if (!Number.isInteger(year)) throw new Error('REVIEW_YEAR ist ungültig.');

const [chatText, annotationsText] = await Promise.all([
  readFile(resolve(chatArgument), 'utf8'),
  readFile(resolve(annotationsArgument), 'utf8'),
]);

const chat = JSON.parse(chatText);
const annotations = JSON.parse(annotationsText);
if (!Array.isArray(chat.messages)) throw new Error('Telegram-Export enthält keine Nachrichtenliste.');

const selectedMessages = chat.messages.filter((message) => {
  const raw = message?.date ?? message?.date_unixtime;
  const numeric = /^\d{9,13}$/.test(String(raw));
  const date = new Date(
    numeric
      ? String(raw).length > 10
        ? Number(raw)
        : Number(raw) * 1000
      : raw,
  );
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() === year;
});

const filteredChat = {
  ...chat,
  name: `${chat.name || datasetName} · ${year}`,
  messages: selectedMessages,
};

const response = await fetch(`${apiBase}/api/admin/import`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${adminToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    datasetId,
    name: datasetName,
    year,
    chat: filteredChat,
    annotations,
  }),
});

const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
if (!response.ok) throw new Error(result.error || `Import fehlgeschlagen: HTTP ${response.status}`);

console.log(JSON.stringify({
  ok: true,
  datasetId: result.datasetId,
  year,
  uploadedMessages: selectedMessages.length,
  situations: result.situations,
  split: result.split,
}, null, 2));
