import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist');
const files = [
  'index.html',
  'review.html',
  'review.css',
  'truewords-theme.css',
  'review.js',
  'review-boundaries.css',
  'review-boundaries.js',
  'admin.html',
  'admin-upload.css',
  'admin-upload.js',
  'analysis-import.html',
  'analysis-import.js',
  'login.html',
  'login.js',
  'account-setup.html',
  'account-setup.js',
  'upload.html',
  'pilot-v2.js',
  'upload.js',
  'portal.css',
  'manifest.webmanifest',
  'icon.svg',
  'sw.js',
  'enhancements.css',
  'enhancements.js',
  'coordination.css',
  'coordination.js',
  'server-sync.css',
  'server-sync.js',
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of files) {
  await cp(resolve(root, file), resolve(dist, file));
}

await writeFile(resolve(dist, '.assetsignore'), '*.map\n', 'utf8');
console.log(`Worker assets prepared in ${dist}`);
