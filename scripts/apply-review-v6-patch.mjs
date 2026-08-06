import { readFile, writeFile } from 'node:fs/promises';

async function replaceRequired(path, search, replacement) {
  const original = await readFile(path, 'utf8');
  if (!original.includes(search)) {
    if (original.includes(replacement)) return false;
    throw new Error(`Expected source block not found in ${path}`);
  }
  await writeFile(path, original.replace(search, replacement), 'utf8');
  return true;
}

await replaceRequired(
  'review.js',
  `  function listSituations() {\n    return state.showCompleted\n      ? [...openSituations(), ...completedSituations()]\n      : openSituations();\n  }`,
  `  function listSituations() {\n    return situations().filter((item) => state.showCompleted || !isDone(item));\n  }`,
);

await replaceRequired(
  'review.js',
  `  function markModified(...ids) {\n    ids.filter(Boolean).forEach((id) => {\n      const item = situation(id);\n      if (item && isDone(item)) item.status = 'open';\n      state.modified.add(Number(id));\n    });\n    state.dirty = true;\n  }\n\n  function shiftBoundary(action) {`,
  `  function markModified(...ids) {\n    ids.filter(Boolean).forEach((id) => {\n      const item = situation(id);\n      if (item && isDone(item)) item.status = 'open';\n      state.modified.add(Number(id));\n    });\n    state.dirty = true;\n  }\n\n  function removeEmptyOwnSituations(exceptId = 0) {\n    const emptyIds = situations()\n      .filter((item) => (\n        Number(item.id) !== Number(exceptId)\n        && isMine(item.id)\n        && situationMessages(item.id).length === 0\n      ))\n      .map((item) => Number(item.id));\n\n    if (!emptyIds.length) return [];\n    const emptySet = new Set(emptyIds);\n    state.annotations.situations = state.annotations.situations\n      .filter((item) => !emptySet.has(Number(item.id)));\n\n    emptyIds.forEach((emptyId) => {\n      delete state.owners[String(emptyId)];\n      state.modified.delete(emptyId);\n    });\n\n    state.annotations.events = Array.isArray(state.annotations.events)\n      ? state.annotations.events\n      : [];\n    const at = new Date().toISOString();\n    emptyIds.forEach((emptyId) => {\n      state.annotations.events.push({\n        type: 'empty_situation_removed',\n        situationId: emptyId,\n        reviewer: state.user.role,\n        at,\n      });\n    });\n    state.annotations.events = state.annotations.events.slice(-2000);\n    state.dirty = true;\n    return emptyIds;\n  }\n\n  function shiftBoundary(action) {`,
);

await replaceRequired(
  'review.js',
  `    if (!movedMessage) return;\n    markModified(id, destinationId && destinationId !== id ? destinationId : 0);\n\n    const updated = situationMessages(id);`,
  `    if (!movedMessage) return;\n    markModified(id, destinationId && destinationId !== id ? destinationId : 0);\n    removeEmptyOwnSituations(id);\n\n    const updated = situationMessages(id);`,
);

await replaceRequired(
  'review.html',
  '<link rel="stylesheet" href="./review.css?v=5">',
  '<link rel="stylesheet" href="./review.css?v=6">',
);
await replaceRequired(
  'review.html',
  '<script src="./review.js?v=5"></script>',
  '<script src="./review.js?v=6"></script>',
);
await replaceRequired(
  'sw.js',
  "const CACHE = 'truewords-review-pwa-server-v4';",
  "const CACHE = 'truewords-review-pwa-server-v5';",
);

console.log('Review v6 patch applied.');
