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
    dataset: { id: 'v31-layout-fixture', name: 'Test 4 · V4', year: 2026, revision: 1 },
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

test('V31 desktop trennt Flächen, nutzt Logo-Sprecherfarben und zentriert aktive Karte', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApis(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });

  const philipp = page.locator('.tw-message-wrap.philipp .tw-message').first();
  const lena = page.locator('.tw-message-wrap.lena .tw-message').first();
  expect(await philipp.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(53, 190, 180)');
  expect(await lena.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(242, 108, 131)');

  const sidebarBg = await page.locator('.tw-sidebar').evaluate((node) => getComputedStyle(node).backgroundColor);
  const cardBg = await page.locator('[data-situation-list] [data-situation-card="2"]').evaluate((node) => getComputedStyle(node).backgroundColor);
  const chatBg = await page.locator('.tw-chat-card').evaluate((node) => getComputedStyle(node).backgroundColor);
  const streamBg = await page.locator('.tw-chat-scroll').evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(sidebarBg).not.toBe(cardBg);
  expect(chatBg).not.toBe(streamBg);

  const positions = await page.locator('[data-situation-list] [data-situation-card="2"]').evaluate((card) => {
    const check = card.querySelector('.tw-sit-check').getBoundingClientRect();
    const open = card.querySelector('.tw-situation-open').getBoundingClientRect();
    return { checkLeft: check.left, openLeft: open.left };
  });
  expect(positions.checkLeft).toBeLessThan(positions.openLeft);

  const boundaryWidth = await page.locator('.tw-boundary').first().evaluate((node) => getComputedStyle(node).borderTopWidth);
  expect(boundaryWidth).toBe('2px');

  await page.locator('[data-situation-list] [data-open-situation="3"]').click();
  await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).toHaveClass(/is-active/);
  await expect.poll(async () => page.locator('[data-situation-list]').evaluate((list) => {
    const card = list.querySelector('[data-situation-card="3"]');
    const a = list.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
  })).toBeLessThanOrEqual(10);
});

test('V31 mobile zeigt kompakte Analysekarte oberhalb des zentrierten Sliders und sauberes Bottom-Sheet', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await mockApis(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme/user/philipp:philipp@example.test', 'dark'));
  await page.goto('/review.html');
  await page.locator('[data-v31-mobile-active]').waitFor({ state: 'visible' });

  await page.locator('[data-slider-situation="3"]').click();
  await expect(page.locator('[data-slider-situation="3"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-v31-mobile-active]')).toHaveAttribute('data-situation-id', '3');

  const order = await page.evaluate(() => {
    const shell = document.querySelector('[data-app-shell]');
    const children = [...shell.children];
    return {
      active: children.indexOf(document.querySelector('[data-v31-mobile-active]')),
      slider: children.indexOf(document.querySelector('[data-situation-slider]')),
    };
  });
  expect(order.active).toBeGreaterThanOrEqual(0);
  expect(order.active).toBeLessThan(order.slider);

  const toggle = page.locator('[data-v31-active-toggle]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.tw-v31-active-details')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.tw-v31-active-details')).toBeVisible();
  await expect(page.locator('.tw-v31-active-details')).toContainText('Klassifizierung');
  await expect(page.locator('.tw-v31-active-details')).toContainText('Richtung');

  await expect.poll(async () => page.locator('[data-situation-slider]').evaluate((slider) => {
    const active = slider.querySelector('[data-slider-situation].is-active');
    const a = slider.getBoundingClientRect();
    const b = active.getBoundingClientRect();
    return Math.abs((a.left + a.width / 2) - (b.left + b.width / 2));
  })).toBeLessThanOrEqual(10);

  await page.getByRole('button', { name: 'Situationsliste öffnen' }).click();
  await expect(page.locator('[data-drawer]')).toHaveClass(/is-open/);
  await expect.poll(async () => page.locator('[data-drawer-list]').evaluate((list) => {
    const active = list.querySelector('[data-situation-card].is-active');
    const a = list.getBoundingClientRect();
    const b = active.getBoundingClientRect();
    return Math.abs((a.top + a.height / 2) - (b.top + b.height / 2));
  })).toBeLessThanOrEqual(10);
  expect(await page.locator('[data-drawer-list]').evaluate((node) => getComputedStyle(node).paddingTop)).toBe('12px');
});
