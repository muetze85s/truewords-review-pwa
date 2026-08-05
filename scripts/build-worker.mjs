import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const dist = resolve(root, 'dist');
const files = [
  'index.html',
  'admin.html',
  'admin-upload.css',
  'admin-upload.js',
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

const indexPath = resolve(dist, 'index.html');
let html = await readFile(indexPath, 'utf8');

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

if (!html.includes('server-sync.css')) {
  html = html.replace('</head>', `  ${styles}\n</head>`);
}
if (!html.includes('server-sync.js')) {
  html = html.replace('</body>', `  ${scripts}\n</body>`);
}

await writeFile(indexPath, html, 'utf8');
await writeFile(resolve(dist, '.assetsignore'), '*.map\n', 'utf8');

console.log(`Worker assets prepared in ${dist}`);
