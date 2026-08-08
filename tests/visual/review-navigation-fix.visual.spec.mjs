import { expect, test } from '@playwright/test';

function bootstrapFixture() {
  const messages = [
    { id: 201, date: '2026-05-01T08:00:00Z', date_unixtime: '1777622400', from: 'Philipp', text: 'Situation eins, Nachricht eins.' },
    { id: 202, date: '2026-05-01T08:03:00Z', date_unixtime: '1777622580', from: 'Lena', text: 'Situation eins, Nachricht zwei.' },
    { id: 203, date: '2026-05-01T09:00:00Z', date_unixtime: '1777626000', from: 'Philipp', text: 'Situation zwei, Nachricht eins.' },
    { id: 204, date: '2026-05-01T09:04:00Z', date_unixtime: '1777626240', from: 'Lena', text: 'Situation zwei, Nachricht zwei.' },
    { id: 205, date: '2026-05-01T10:00:00Z', date_unixtime: '1777629600', from: 'Philipp', text: 'Situation drei, Nachricht eins.' },
    { id: 206, date: '2026-05-01T10:06:00Z', date_unixtime: '1777629960', from: 'Lena', text: 'Situation drei, Nachricht zwei.' },
  ];
  return {
    ok: true,
    user: { id: 1, email: 'philipp@example.test', role: 'Philipp', canUpload: true },
    dataset: { id: 'navigation-fixture', name: 'Navigation Fixture', year: 2026, revision: 1 },
    owners: { '1': 'Philipp', '2': 'Philipp', '3': 'Philipp' },
    annotations: {
      schemaVersion: 'truewords-manual-segmentation/v4-unseen',
      situations: [
        { id: 1, status: 'confirmed' },
        { id: 2, status: 'open' },
        { id: 3, status: 'open' },
      ],
      assignments: { '201': 1, '202': 1, '203': 2, '204': 2, '205': 3, '206': 3 },
      events: [],
      testFilter: { schemaVersion: 'truewords-test-filter/v1', selection: { eventIds: messages.map((message) => message.id) } },
    },
    messages,
    replyMessages: [],
    window: { messages: 6, assigned: 6, situations: 3, exactTestFilter: true },
  };
}

async function mockApis(page) {
  const current = structuredClone(bootstrapFixture());
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

test('Situation bleibt nach Re-Render mehrfach auswählbar und fokussiert korrekt', async ({ page }) => {
  await mockApis(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });

  await page.locator('[data-situation-list] [data-open-situation="1"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveClass(/is-active/);

  await page.getByRole('button', { name: 'Bestätigung zurücknehmen' }).click();
  await expect(page.getByRole('button', { name: 'Situation bestätigen' })).toBeVisible();
  await page.getByRole('button', { name: 'Situation bestätigen' }).click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveClass(/is-active/);

  await page.locator('[data-situation-list] [data-open-situation="2"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="2"]')).toHaveClass(/is-active/);
  await page.locator('[data-situation-list] [data-open-situation="1"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="1"]')).toHaveClass(/is-active/);
  await page.locator('[data-situation-list] [data-open-situation="2"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="2"]')).toHaveClass(/is-active/);

  const focus = await page.locator('[data-message-situation="2"][data-situation-first="true"]').evaluate((node) => {
    const scroll = node.closest('[data-chat-scroll]');
    const targetRect = node.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    return targetRect.top - scrollRect.top;
  });
  expect(focus).toBeGreaterThanOrEqual(8);
  expect(focus).toBeLessThanOrEqual(70);
});

test('Mobile Bottom-Sheet wechselt Situationen bei fixer Kopfzeile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApis(page);
  await page.goto('/review.html');
  await page.locator('.tw-chat-scroll').waitFor({ state: 'visible' });

  await expect(page.locator('.tw-topbar')).toBeVisible();
  await expect(page.locator('[data-situation-slider]')).toBeVisible();
  await expect(page.locator('.tw-bottom-nav')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Situationsliste öffnen' })).toBeVisible();

  await page.getByRole('button', { name: 'Situationsliste öffnen' }).click();
  await expect(page.locator('[data-drawer]')).toHaveClass(/is-open/);
  await page.locator('[data-drawer-list] [data-open-situation="3"]').click();
  await expect(page.locator('[data-slider-situation="3"]')).toHaveClass(/is-active/);

  await page.getByRole('button', { name: 'Situationsliste öffnen' }).click();
  await page.locator('[data-drawer-list] [data-open-situation="2"]').click();
  await expect(page.locator('[data-slider-situation="2"]')).toHaveClass(/is-active/);

  // In V30 liegt der Chat als eigene Grid-Zeile bereits unter fester Kopfzeile
  // und Embla-Slider. Deshalb ist kein künstlicher 145px-Innenabstand nötig.
  const focus = await page.locator('[data-message-situation="2"][data-situation-first="true"]').evaluate((node) => {
    const scroll = node.closest('[data-chat-scroll]');
    return node.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  });
  expect(focus).toBeGreaterThanOrEqual(8);
  expect(focus).toBeLessThanOrEqual(70);
});

test('Login startet mit System und angemeldeter Nutzer erhält eigene Theme-Wahl', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('truewords/theme', 'dark'));
  await page.route('**/api/auth/me', async (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: '{"ok":false}',
  }));
  await page.route('**/api/auth/setup-status', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"ok":true,"configured":true}',
  }));
  await page.goto('/login.html');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('truewords/theme'))).toBe('system');

  await page.unroute('**/api/auth/me');
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.route('**/api/auth/me', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, user: { email: 'philipp@example.test', role: 'Philipp', canUpload: true } }),
  }));
  await page.route('**/api/situation-quiz/status', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: '{"ok":true,"required":false,"completed":true}',
  }));
  await page.goto('/situation-info.html');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.getByRole('button', { name: 'Hell' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('truewords/theme/user/philipp:philipp@example.test'))).toBe('light');
});
