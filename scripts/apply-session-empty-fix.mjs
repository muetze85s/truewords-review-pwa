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

for (const path of ['src/worker-auth-fast.ts', 'src/worker-portal.ts']) {
  await replaceRequired(
    path,
    "const SESSION_COOKIE = 'tw_review_session';",
    "const SESSION_COOKIE = 'tw_review_session_v2';",
  );
  await replaceRequired(
    path,
    'const SESSION_SECONDS = 30 * 24 * 60 * 60;',
    'const SESSION_SECONDS = 12 * 60 * 60;',
  );
  await replaceRequired(
    path,
    'return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;',
    'return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict`;',
  );
}

await replaceRequired(
  'src/worker-chat-stream.ts',
  "const SESSION_COOKIE = 'tw_review_session';",
  "const SESSION_COOKIE = 'tw_review_session_v2';",
);

await replaceRequired(
  'review.js',
  `  function removeEmptyOwnSituations(exceptId = 0) {\n    const emptyIds = situations()\n      .filter((item) => (\n        Number(item.id) !== Number(exceptId)\n        && isMine(item.id)\n        && situationMessages(item.id).length === 0\n      ))\n      .map((item) => Number(item.id));`,
  `  function removeEmptySituations(exceptId = 0) {\n    const emptyIds = situations()\n      .filter((item) => (\n        Number(item.id) !== Number(exceptId)\n        && situationMessages(item.id).length === 0\n      ))\n      .map((item) => Number(item.id));`,
);
await replaceRequired(
  'review.js',
  '    removeEmptyOwnSituations(id);',
  '    removeEmptySituations(id);',
);
await replaceRequired(
  'review.js',
  `      state.modified.clear();\n      state.dirty = false;\n      state.scrollTarget = null;\n      renderWorkspace();`,
  `      state.modified.clear();\n      state.dirty = false;\n      state.scrollTarget = null;\n      const removedEmpty = removeEmptySituations(0);\n      if (removedEmpty.length) await saveState();\n      renderWorkspace();`,
);

await replaceRequired(
  'src/worker-d1.ts',
  `  for (const id of newSituationIds) nextOwners[String(id)] = reviewer;\n\n  const merged: AnnotationPayload = {\n    ...current,\n    datasetHash: dataset.dataset_hash,\n    datasetLabel: dataset.name,\n    situations: mergedSituations,\n    assignments: mergedAssignments,`,
  `  for (const id of newSituationIds) nextOwners[String(id)] = reviewer;\n\n  const assignedSituationIds = new Set(\n    Object.values(mergedAssignments)\n      .map((value) => Number(value))\n      .filter((value) => Number.isInteger(value) && value > 0),\n  );\n  const removedEmptySituationIds = mergedSituations\n    .map((situation) => Number(situation.id))\n    .filter((id) => !assignedSituationIds.has(id));\n  const removedEmptySet = new Set(removedEmptySituationIds);\n  const prunedSituations = mergedSituations.filter(\n    (situation) => !removedEmptySet.has(Number(situation.id)),\n  );\n  for (const id of removedEmptySituationIds) delete nextOwners[String(id)];\n\n  const merged: AnnotationPayload = {\n    ...current,\n    datasetHash: dataset.dataset_hash,\n    datasetLabel: dataset.name,\n    situations: prunedSituations,\n    assignments: mergedAssignments,`,
);
await replaceRequired(
  'src/worker-d1.ts',
  `        situations: [...ownedAfterMerge].sort((a, b) => a - b),\n        newSituationIds,`,
  `        situations: [...ownedAfterMerge]\n          .filter((id) => !removedEmptySet.has(id))\n          .sort((a, b) => a - b),\n        newSituationIds: newSituationIds.filter((id) => !removedEmptySet.has(id)),\n        removedEmptySituationIds,`,
);
await replaceRequired(
  'src/worker-d1.ts',
  `    revision: updated?.revision ?? dataset.revision + 1,\n    updatedAt: updated?.updated_at ?? now,`,
  `    revision: updated?.revision ?? dataset.revision + 1,\n    updatedAt: updated?.updated_at ?? now,\n    removedEmptySituationIds,`,
);

await replaceRequired(
  'review.html',
  '<link rel="stylesheet" href="./review.css?v=6">',
  '<link rel="stylesheet" href="./review.css?v=7">',
);
await replaceRequired(
  'review.html',
  '<script src="./review.js?v=6"></script>',
  '<script src="./review.js?v=7"></script>',
);
await replaceRequired(
  'sw.js',
  "const CACHE = 'truewords-review-pwa-server-v5';",
  "const CACHE = 'truewords-review-pwa-server-v6';",
);

console.log('Session and empty-situation fix applied.');
