import { expect, test } from '@playwright/test';

function fixture() {
  const messages = [
    { id: 301, date: '2026-05-09T08:00:00Z', date_unixtime: '1778313600', from: 'Philipp Mustermann', text: 'Erste Nachricht Situation eins.' },
    { id: 302, date: '2026-05-09T08:04:00Z', date_unixtime: '1778313840', from: 'Lena Beispiel', text: 'Zweite Nachricht Situation eins.' },
    { id: 303, date: '2026-05-09T09:00:00Z', date_unixtime: '1778317200', from: 'Philipp Mustermann', text: 'Erste Nachricht Situation zwei.' },
    { id: 304, date: '2026-05-09T09:06:00Z', date_unixtime: '1778317560', from: 'Lena Beispiel', text: 'Zweite Nachricht Situation zwei.' },
    { id: 305, date: '2026-05-09T10:00:00Z', date_unixtime: '1778320800', from: 'Philipp Mustermann', text: 'Erste Nachricht Situation drei.' },
    { id: 306, date: '2026-05-09T10:08:00Z', date_unixtime: '1778321280', from: 'Lena Beispiel', text: 'Zweite Nachricht Situation drei.' },
  ];
  return {
    ok: true,
    user: { id: 1, email: 'philipp@example.test', role: 'Philipp', canUpload: true },
    dataset: { id: 'interaction-fixture', name: 'Interaction Fixture', year: 2026, revision: 1 },
    owners: { '1': 'Philipp', '2': 'Philipp', '3': 'Philipp' },
    annotations: {
      schemaVersion: 'truewords-manual-segmentation/v4-unseen',
      situations: [
        { id: 1, status: 'open' },
        { id: 2, status: 'open' },
        { id: 3, status: 'open' },
      ],
      assignments: { '301': 1, '302': 1, '303': 2, '304': 2, '305': 3, '306': 3 },
      events: [],
      testFilter: { schemaVersion: 'truewords-test-filter/v1', selection: { eventIds: messages.map((message) => message.id) } },
    },
    messages,
    replyMessages: [],
    window: { messages: 6, assigned: 6, situations: 3, exactTestFilter: true },
  };
}

async function mockReview(page) {
  const current = structuredClone(fixture());
  let revision = 1;
  await page.route('**/api/auth/me', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: current.user }) }));
  await page.route('**/api/review/bootstrap', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }));
  await page.route('**/api/state**', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.annotations) current.annotations = structuredClone(body.annotations);
      revision += 1;
      current.dataset.revision = revision;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revision }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/auth/logout', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

test('Nachricht kann nach Re-Render abgewählt und eine andere ausgewählt werden', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  const wrap302 = () => page.locator('[data-message-wrap="302"]');
  await page.locator('[data-message-id="302"]').click();
  await expect(wrap302()).toHaveClass(/is-selected/);
  await expect(page.getByRole('button', { name: 'Neue Situation ab hier' })).toBeVisible();
  await page.locator('[data-message-id="302"]').click();
  await expect(wrap302()).not.toHaveClass(/is-selected/);
  await page.locator('[data-message-id="302"]').click();
  await page.locator('[data-message-id="301"]').click();
  await expect(page.locator('[data-message-wrap="301"]')).toHaveClass(/is-selected/);
  await expect(wrap302()).not.toHaveClass(/is-selected/);
});

test('Scrollen aktiviert Situation ohne Chat-Sprung und hält linke Karte mittig', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  await page.locator('[data-message-id="302"]').click();
  const beforeSyncTop = await page.locator('[data-chat-scroll]').evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    return node.querySelector('[data-message-wrap="305"]')?.getBoundingClientRect().top ?? 0;
  });
  await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-message-wrap="302"]')).toHaveClass(/is-selected/);
  const afterSyncTop = await page.locator('[data-message-wrap="305"]').evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(afterSyncTop - beforeSyncTop)).toBeLessThanOrEqual(2);
  await expect.poll(async () => page.locator('[data-situation-list]').evaluate((list) => {
    const card = list.querySelector('[data-situation-card="3"]');
    if (!card) return 9999;
    const a = list.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    return Math.abs((b.top + b.height / 2) - (a.top + a.height / 2));
  })).toBeLessThanOrEqual(14);
});

test('Ende-Zeile enthält Bestätigung und separater Abschlussblock ist entfernt', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  const boundary = page.locator('[data-boundary-end="1"]');
  await expect(boundary).toBeVisible();
  await expect(boundary.locator('[data-confirm="1"]')).toHaveCount(1);
  const endCard = page.locator('[data-end-card="1"]');
  expect(await endCard.evaluate((node) => getComputedStyle(node).display)).toBe('none');
  expect(await endCard.evaluate((node) => node.getBoundingClientRect().height)).toBe(0);
  const activeHeight = await page.locator('[data-boundary-end="1"]').evaluate((node) => node.getBoundingClientRect().height);
  const inactiveHeight = await page.locator('[data-boundary-end="2"]').evaluate((node) => node.getBoundingClientRect().height);
  expect(Math.abs(activeHeight - inactiveHeight)).toBeLessThanOrEqual(1);
});

test('Bestätigen bleibt an derselben Chatstelle und in derselben Situation', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  await page.locator('[data-open-situation="2"]').first().click();
  await page.locator('[data-message-id="304"]').click();
  const beforeTop = await page.locator('[data-message-wrap="304"]').evaluate((node) => node.getBoundingClientRect().top);
  await page.locator('[data-boundary-end="2"] [data-confirm="2"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="2"]')).toHaveAttribute('data-status', 'confirmed');
  await expect(page.locator('[data-situation-list] [data-situation-card="2"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-message-wrap="304"]')).toHaveClass(/is-selected/);
  const afterTop = await page.locator('[data-message-wrap="304"]').evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(2);
  await page.locator('[data-boundary-end="2"] [data-confirm="2"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="2"]')).toHaveAttribute('data-status', 'open');
});

test('Checkbox bestätigt und hebt Bestätigung wieder auf', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  const check1 = page.locator('[data-situation-list] [data-situation-card="1"] .tw-sit-check');
  await check1.click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveAttribute('data-status', 'confirmed');
  const undo = page.locator('[data-boundary-end="1"] [data-confirm="1"]');
  const rgb = (await undo.evaluate((node) => getComputedStyle(node).backgroundColor)).match(/\d+/g)?.map(Number) || [];
  expect(rgb[0]).toBeGreaterThan(rgb[1]);
  expect(rgb[0]).toBeGreaterThan(rgb[2]);
  await page.locator('[data-situation-list] [data-situation-card="1"] .tw-sit-check').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveAttribute('data-status', 'open');
});

test('TrueWords Farben, Perspektive, Vornamen und Statusrahmen sind konsistent', async ({ page }) => {
  await mockReview(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  await expect(page.locator('[data-message-id="301"] .tw-message-meta strong')).toHaveText('Philipp');
  await expect(page.locator('[data-message-id="302"] .tw-message-meta strong')).toHaveText('Lena');
  const philipp = await page.locator('[data-message-wrap="301"] .tw-message').evaluate((node) => getComputedStyle(node).backgroundColor);
  const lena = await page.locator('[data-message-wrap="302"] .tw-message').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(philipp).toContain('53, 190, 180');
  expect(lena).toContain('242, 108, 131');
  const positions = await page.evaluate(() => ({
    philipp: document.querySelector('[data-message-wrap="301"] .tw-message')?.getBoundingClientRect().left || 0,
    lena: document.querySelector('[data-message-wrap="302"] .tw-message')?.getBoundingClientRect().left || 0,
  }));
  expect(positions.philipp).toBeGreaterThan(positions.lena);
  const borders = await page.locator('[data-situation-card="1"]').first().evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  });
  expect(new Set(borders).size).toBe(1);
});

test('Nach Upload-Markierung wird die Infoseite übersprungen', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  await page.evaluate(() => sessionStorage.setItem('truewords/review-after-upload', '1'));
  await page.goto('/situation-info.html');
  await expect(page).toHaveURL(/\/review\.html$/);
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('truewords/review-after-upload'))).toBeNull();
});
