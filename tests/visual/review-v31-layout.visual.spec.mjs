import { expect, test } from '@playwright/test';

function fixture() {
  const messages = [];
  let id = 501;
  for (let situation = 1; situation <= 5; situation += 1) {
    const day = String(8 + situation).padStart(2, '0');
    messages.push({ id: id++, date: `2026-05-${day}T08:00:00Z`, date_unixtime: String(1778000000 + situation * 7200), from: 'Philipp', text: `Philipp Situation ${situation}` });
    messages.push({ id: id++, date: `2026-05-${day}T08:05:00Z`, date_unixtime: String(1778000300 + situation * 7200), from: 'Lena', text: `Lena Situation ${situation}` });
  }
  const assignments = {};
  messages.forEach((message, index) => { assignments[String(message.id)] = Math.floor(index / 2) + 1; });
  return {
    ok: true,
    user: { id: 1, email: 'philipp@example.test', role: 'Philipp', canUpload: true },
    dataset: { id: 'v33-layout-fixture', name: 'Test 4 · V4', year: 2026, revision: 1 },
    owners: { '1': 'Philipp', '2': 'Philipp', '3': 'Philipp', '4': 'Philipp', '5': 'Philipp' },
    annotations: {
      schemaVersion: 'truewords-manual-segmentation/v4-unseen',
      situations: [
        { id: 1, status: 'open' },
        { id: 2, status: 'open' },
        { id: 3, status: 'open', analysis: {
          classification: 'Konflikt · Klärung',
          direction: 'Philipp → Lena',
          startingConcern: 'Mehr Rückmeldung bei Rückzug',
          topics: ['Nähe', 'Rückzug'],
          patterns: ['Pauschalisierung', 'Gegenkritik'],
          repair: 'Ansatz vorhanden',
          outcome: 'Offen',
        } },
        { id: 4, status: 'open' },
        { id: 5, status: 'open' },
      ],
      assignments,
      events: [],
      testFilter: { schemaVersion: 'truewords-test-filter/v1', selection: { eventIds: messages.map((message) => message.id) } },
    },
    messages,
    replyMessages: [],
    window: { messages: messages.length, assigned: messages.length, situations: 5, exactTestFilter: true },
  };
}

async function mockApis(page) {
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, dataset: current.dataset, annotations: current.annotations, owners: current.owners }) });
  });
  await page.route('**/api/auth/logout', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

async function expectFixedCenter(page, rootSelector, activeSelector, tolerance = 2) {
  await expect.poll(async () => page.locator(rootSelector).evaluate((root, selector) => {
    const active = root.querySelector(selector);
    if (!active) return 9999;
    const a = root.getBoundingClientRect();
    const b = active.getBoundingClientRect();
    const horizontal = root.matches('[data-v33-mobile-strip]');
    return horizontal
      ? Math.abs((a.left + a.width / 2) - (b.left + b.width / 2))
      : Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
  }, activeSelector)).toBeLessThanOrEqual(tolerance);
}

test('V33 desktop nutzt feste Mittellage, synchronisiert mit Chat und springt auf die Anfangsgrenze', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApis(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.goto('/review.html');
  await page.locator('[data-v33-fixed-list="sidebar"]').waitFor({ state: 'visible' });

  const philipp = page.locator('.tw-message-wrap.philipp .tw-message').first();
  const lena = page.locator('.tw-message-wrap.lena .tw-message').first();
  expect(await philipp.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(53, 190, 180)');
  expect(await lena.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(242, 108, 131)');

  const sidebarBg = await page.locator('.tw-sidebar').evaluate((node) => getComputedStyle(node).backgroundColor);
  const cardBg = await page.locator('[data-v33-fixed-list="sidebar"] [data-v33-nav-id="2"]').evaluate((node) => getComputedStyle(node).backgroundColor);
  const chatBg = await page.locator('.tw-chat-card').evaluate((node) => getComputedStyle(node).backgroundColor);
  const streamBg = await page.locator('.tw-chat-scroll').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(sidebarBg).not.toBe(cardBg);
  expect(chatBg).not.toBe(streamBg);

  const positions = await page.locator('[data-v33-fixed-list="sidebar"] [data-v33-nav-id="2"]').evaluate((card) => {
    const check = card.querySelector('.tw-sit-check').getBoundingClientRect();
    const open = card.querySelector('.tw-situation-open').getBoundingClientRect();
    return { checkLeft: check.left, openLeft: open.left };
  });
  expect(positions.checkLeft).toBeLessThan(positions.openLeft);

  await page.locator('[data-v33-fixed-list="sidebar"] [data-v33-nav-id="3"] .tw-situation-open').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-v33-fixed-list="sidebar"] .tw-v33-list-center [data-v33-nav-id="3"]')).toBeVisible();
  await expectFixedCenter(page, '[data-v33-fixed-list="sidebar"]', '.tw-v33-list-center [data-v33-nav-id="3"]');

  const boundaryInset = await page.locator('[data-boundary-start="3"]').evaluate((node) => {
    const scroll = node.closest('[data-chat-scroll]');
    return node.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  });
  expect(boundaryInset).toBeGreaterThanOrEqual(6);
  expect(boundaryInset).toBeLessThanOrEqual(18);

  const centerBefore = await page.locator('[data-v33-fixed-list="sidebar"] .tw-v33-list-center').evaluate((node) => node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2);
  await page.locator('[data-chat-scroll]').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(page.locator('[data-situation-list] [data-situation-card="5"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-v33-fixed-list="sidebar"] .tw-v33-list-center [data-v33-nav-id="5"]')).toBeVisible();
  const centerAfter = await page.locator('[data-v33-fixed-list="sidebar"] .tw-v33-list-center').evaluate((node) => node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2);
  expect(Math.abs(centerAfter - centerBefore)).toBeLessThanOrEqual(1);
});

test('V33 mobile hält den aktiven Slot fest in der Mitte und wechselt per Wischgeste nur dessen Inhalt', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApis(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.goto('/review.html');
  await page.locator('[data-v33-mobile-strip]').waitFor({ state: 'visible' });
  await page.locator('[data-v31-mobile-active]').waitFor({ state: 'visible' });

  await page.locator('[data-v33-mobile-strip] [data-v33-nav-id="3"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-v33-mobile-strip] .tw-v33-strip-center [data-v33-nav-id="3"]')).toBeVisible();
  await expect(page.locator('[data-v31-mobile-active]')).toHaveAttribute('data-situation-id', '3');
  await expectFixedCenter(page, '[data-v33-mobile-strip]', '.tw-v33-strip-center [data-v33-nav-id="3"]');

  const toggle = page.locator('[data-v31-active-toggle]');
  await toggle.click();
  await expect(page.locator('.tw-v31-active-details')).toBeVisible();
  await expect(page.locator('.tw-v31-active-details')).toContainText('Klassifizierung');
  await expect(page.locator('.tw-v31-active-details')).toContainText('Richtung');
  await toggle.click();

  const stripBoxBefore = await page.locator('[data-v33-mobile-strip] .tw-v33-strip-center').boundingBox();
  const strip = page.locator('[data-v33-mobile-strip]');
  const box = await strip.boundingBox();
  if (!box || !stripBoxBefore) throw new Error('Feste mobile Situationsleiste fehlt');
  const y = box.y + box.height / 2;
  const startX = box.x + box.width / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX - 92, y, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator('[data-situation-list] [data-situation-card="4"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-v33-mobile-strip] .tw-v33-strip-center [data-v33-nav-id="4"]')).toBeVisible();
  await expect(page.locator('[data-v31-mobile-active]')).toHaveAttribute('data-situation-id', '4');
  await expectFixedCenter(page, '[data-v33-mobile-strip]', '.tw-v33-strip-center [data-v33-nav-id="4"]');

  const stripBoxAfter = await page.locator('[data-v33-mobile-strip] .tw-v33-strip-center').boundingBox();
  if (!stripBoxAfter) throw new Error('Mittlerer Slot fehlt nach Wischgeste');
  expect(Math.abs(stripBoxAfter.x - stripBoxBefore.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(stripBoxAfter.width - stripBoxBefore.width)).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Situationsliste öffnen' }).click();
  await expect(page.locator('[data-drawer]')).toHaveClass(/is-open/);
  await expect(page.locator('[data-v33-fixed-list="drawer"] .tw-v33-list-center [data-v33-nav-id="4"]')).toBeVisible();
  await expectFixedCenter(page, '[data-v33-fixed-list="drawer"]', '.tw-v33-list-center [data-v33-nav-id="4"]');
});
