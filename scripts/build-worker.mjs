import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist');
const files = [
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

let reviewHtml = await readFile(resolve(root, 'index.html'), 'utf8');
const styles = [
  '<link rel="stylesheet" href="./enhancements.css">',
  '<link rel="stylesheet" href="./coordination.css">',
  '<link rel="stylesheet" href="./server-sync.css">',
].join('\n  ');
const scripts = [
  '<script src="./enhancements.js"></script>',
  '<script src="./coordination.js"></script>',
  '<script src="./server-sync.js"></script>',
].join('\n  ');

if (!reviewHtml.includes('server-sync.css')) {
  reviewHtml = reviewHtml.replace('</head>', `  ${styles}\n</head>`);
}
if (!reviewHtml.includes('server-sync.js')) {
  reviewHtml = reviewHtml.replace('</body>', `  ${scripts}\n</body>`);
}

await writeFile(resolve(dist, 'index.html'), reviewHtml, 'utf8');
await writeFile(resolve(dist, 'review.html'), reviewHtml, 'utf8');
await writeFile(resolve(dist, '.assetsignore'), '*.map\n', 'utf8');

console.log(`Worker assets prepared in ${dist}`);
