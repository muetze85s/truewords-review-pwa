import { expect, test } from '@playwright/test';

function fixture() {
  const messages = [
    { id: 301, date: '2026-05-09T08:00:00Z', date_unixtime: '1778313600', from: 'Philipp', text: 'Erste Nachricht Situation eins.' },
    { id: 302, date: '2026-05-09T08:04:00Z', date_unixtime: '1778313840', from: 'Lena', text: 'Zweite Nachricht Situation eins.' },
    { id: 303, date: '2026-05-09T09:00:00Z', date_unixtime: '1778317200', from: 'Philipp', text: 'Erste Nachricht Situation zwei.' },
    { id: 304, date: '2026-05-09T09:06:00Z', date_unixtime: '1778317560', from: 'Lena', text: 'Zweite Nachricht Situation zwei.' },
    { id: 305, date: '2026-05-09T10:00:00Z', date_unixtime: '1778320800', from: 'Philipp', text: 'Erste Nachricht Situation drei.' },
    { id: 306, date: '2026-05-09T10:08:00Z', date_unixtime: '1778321280', from: 'Lena', text: 'Zweite Nachricht Situation drei.' },
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
  await page.route('**/api/auth/me', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, user: current.user }),
  }));
  await page.route('**/api/review/bootstrap', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(current),
  }));
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
  await expect(page.getByRole('button', { name: 'Neue Situation ab hier' })).toHaveCount(0);

  await page.locator('[data-message-id="302"]').click();
  await page.locator('[data-message-id="301"]').click();
  await expect(page.locator('[data-message-wrap="301"]')).toHaveClass(/is-selected/);
  await expect(wrap302()).not.toHaveClass(/is-selected/);
});

test('Normales Scrollen verändert die aktive Situation nicht', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveClass(/is-active/);

  await page.locator('[data-chat-scroll]').evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await page.waitForTimeout(250);

  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).not.toHaveClass(/is-active/);
});

test('Checkbox bestätigt und hebt Bestätigung wieder auf', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });

  const check1 = page.locator('[data-situation-list] [data-situation-card="1"] .tw-sit-check');
  await check1.click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveAttribute('data-status', 'confirmed');
  await expect(page.locator('[data-situation-list] [data-situation-card="1"] .tw-sit-check')).toContainText('✓');

  const undo = page.locator('[data-confirm="1"]');
  const undoBg = await undo.evaluate((node) => getComputedStyle(node).backgroundColor);
  const rgb = undoBg.match(/\d+/g)?.map(Number) || [];
  expect(rgb.length).toBeGreaterThanOrEqual(3);
  expect(rgb[0]).toBeGreaterThan(rgb[1]);
  expect(rgb[0]).toBeGreaterThan(rgb[2]);

  await page.locator('[data-situation-list] [data-situation-card="1"] .tw-sit-check').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveAttribute('data-status', 'open');
  await expect(page.locator('[data-situation-list] [data-situation-card="1"] .tw-sit-check')).toHaveText('');
});

test('TrueWords Sprechblasen sind Türkis und Rosa und aktive Situation ist heller', async ({ page }) => {
  await mockReview(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });

  const philipp = await page.locator('[data-message-wrap="301"] .tw-message').evaluate((node) => getComputedStyle(node).backgroundColor);
  const lena = await page.locator('[data-message-wrap="302"] .tw-message').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(philipp).toContain('53, 190, 180');
  expect(lena).toContain('242, 108, 131');

  const activeBg = await page.locator('[data-situation-list] [data-situation-card="1"]').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(activeBg).toBe('rgb(48, 48, 56)');
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
