import { expect, test } from '@playwright/test';

function fixtureBootstrap() {
  const messages = [
    { id: 101, date: '2026-05-01T08:00:00+00:00', date_unixtime: '1777622400', from: 'Philipp', text: 'Wir müssen später noch den Termin klären.' },
    { id: 102, date: '2026-05-01T08:03:00+00:00', date_unixtime: '1777622580', from: 'Lena', text: 'Ja, schick mir bitte die Uhrzeit.' },
    { id: 103, date: '2026-05-01T08:05:00+00:00', date_unixtime: '1777622700', from: 'Philipp', text: 'Mache ich.' },
    { id: 104, date: '2026-05-01T10:20:00+00:00', date_unixtime: '1777630800', from: 'Lena', text: 'Wegen heute Morgen wollte ich noch etwas sagen.', reply_to_message_id: 101 },
    { id: 105, date: '2026-05-01T10:23:00+00:00', date_unixtime: '1777630980', from: 'Philipp', text: 'Okay, sag mir was du meinst.' },
    { id: 106, date: '2026-05-01T10:31:00+00:00', date_unixtime: '1777631460', from: 'Lena', text: 'Mir ging es mehr um die Art, wie es gesagt wurde.' },
    { id: 107, date: '2026-05-02T07:30:00+00:00', date_unixtime: '1777707000', from: 'Philipp', text: 'Guten Morgen. Ich bin jetzt unterwegs.' },
    { id: 108, date: '2026-05-02T07:36:00+00:00', date_unixtime: '1777707360', from: 'Lena', text: 'Guten Morgen. Fahr vorsichtig.' },
    { id: 109, date: '2026-05-02T12:42:00+00:00', date_unixtime: '1777725720', from: 'Philipp', text: 'Bin angekommen.' },
    { id: 110, date: '2026-05-03T09:00:00+00:00', date_unixtime: '1777798800', from: 'Lena', text: 'Hast du die Unterlagen gefunden?' },
    { id: 111, date: '2026-05-03T09:04:00+00:00', date_unixtime: '1777799040', from: 'Philipp', text: 'Ja, ich schicke sie gleich.' },
    { id: 112, date: '2026-05-03T09:09:00+00:00', date_unixtime: '1777799340', from: 'Lena', text: 'Danke.' },
  ];
  return {
    ok: true,
    user: { id: 1, email: 'philipp@example.test', role: 'Philipp', canUpload: true },
    dataset: { id: 'fixture-v2', name: 'Philipp & Lena · Review V2', year: 2026, revision: 4 },
    owners: { '1': 'Philipp', '2': 'Philipp', '3': 'Lena', '4': 'Lena' },
    annotations: {
      schemaVersion: 'truewords-manual-segmentation/v2',
      situations: [
        { id: 1, status: 'confirmed', analysis: { classification: 'Organisation', direction: 'Philipp → Lena', patterns: ['Abstimmung'] } },
        { id: 2, status: 'open', analysis: { classification: 'Klärung', direction: 'Lena → Philipp', patterns: ['Nachfrage', 'Reparatur'], topics: ['Ton', 'Wirkung'] } },
        { id: 3, status: 'corrected', analysis: { classification: 'Alltag' } },
        { id: 4, status: 'unclear', analysis: { classification: 'Organisation' } },
      ],
      assignments: {
        '101': 1, '102': 1, '103': 1,
        '104': 2, '105': 2, '106': 2,
        '107': 3, '108': 3, '109': 3,
        '110': 4, '111': 4, '112': 4,
      },
      events: [],
      testFilter: { schemaVersion: 'truewords-test-filter/v1', selection: { eventIds: messages.map((message) => message.id) } },
    },
    messages,
    replyMessages: [],
    window: { messages: 12, assigned: 12, situations: 4, exactTestFilter: true },
  };
}

async function mockReviewApi(page) {
  const current = structuredClone(fixtureBootstrap());
  let revision = 4;

  await page.route('**/api/review/bootstrap', async (route) => {
    current.dataset.revision = revision;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) });
  });

  await page.route('**/api/state**', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.annotations) {
        current.annotations = structuredClone(body.annotations);
        for (const item of current.annotations.situations || []) {
          if (!current.owners[String(item.id)]) current.owners[String(item.id)] = 'Philipp';
        }
      }
      revision += 1;
      current.dataset.revision = revision;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revision }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, dataset: { ...current.dataset, revision }, annotations: current.annotations, owners: current.owners }),
    });
  });
  await page.route('**/api/auth/logout', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

for (const theme of ['light', 'dark']) {
  test(`production Review V2 ${theme}`, async ({ page }, testInfo) => {
    await mockReviewApi(page);
    await page.addInitScript((selectedTheme) => localStorage.setItem('truewords/theme', selectedTheme), theme);
    await page.goto('/review.html');
    await page.locator('.tw-workspace').waitFor({ state: 'visible' });

    const bodyBg = await page.locator('body').evaluate((node) => getComputedStyle(node).backgroundColor);
    const card = page.locator('.tw-sidebar');
    const cardBg = await card.evaluate((node) => getComputedStyle(node).backgroundColor);
    const radius = await card.evaluate((node) => getComputedStyle(node).borderRadius);
    const backdrop = await card.evaluate((node) => getComputedStyle(node).backdropFilter || 'none');
    const backgroundImage = await page.locator('.tw-chat-card').evaluate((node) => getComputedStyle(node).backgroundImage);

    if (theme === 'light') {
      expect(bodyBg).toBe('rgb(243, 244, 246)');
      expect(cardBg).toBe('rgb(255, 255, 255)');
    } else {
      expect(bodyBg).toBe('rgb(18, 18, 20)');
      expect(cardBg).toBe('rgb(30, 30, 34)');
      expect(await card.evaluate((node) => getComputedStyle(node).boxShadow)).toBe('none');
    }
    expect(radius).toBe('28px');
    expect(backdrop).toBe('none');
    expect(backgroundImage).toBe('none');

    const card2 = page.locator('[data-situation-list] [data-situation-card="2"]');
    await expect(card2).toHaveClass(/is-active/);
    await expect(card2).toContainText('Klärung');
    await expect(card2).toContainText('Richtung');
    await expect(card2).toContainText('Muster');

    await page.locator('[data-situation-list] [data-open-situation="3"]').click();
    await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).toHaveClass(/is-active/);
    await page.locator('[data-situation-list] [data-open-situation="2"]').click();
    await expect(page.locator('[data-situation-list] [data-situation-card="2"]')).toHaveClass(/is-active/);

    const philippBg = await page.locator('.tw-message-wrap.philipp .tw-message').first().evaluate((node) => getComputedStyle(node).backgroundColor);
    const lenaBg = await page.locator('.tw-message-wrap.lena .tw-message').first().evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(philippBg).not.toBe(lenaBg);

    await page.locator('[data-message-id="105"]').click();
    await expect(page.getByRole('button', { name: 'Neue Situation ab hier' })).toBeVisible();
    await page.getByRole('button', { name: 'Neue Situation ab hier' }).click();
    await expect(page.locator('[data-situation-list]')).toContainText('2A', { timeout: 8000 });
    await expect(page.locator('[data-situation-list] [data-situation-card="5"]')).toHaveClass(/is-active/);

    const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
    await testInfo.attach(`review-v2-${theme}.png`, { body: screenshot, contentType: 'image/png' });
    expect(screenshot.byteLength).toBeGreaterThan(50_000);
  });
}

test('Review V2 mobile header collapses to synchronized situation slider', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockReviewApi(page);
  await page.addInitScript(() => localStorage.setItem('truewords/theme', 'dark'));
  await page.goto('/review.html');
  await page.locator('.tw-chat-scroll').waitFor({ state: 'visible' });

  await page.locator('.tw-chat-scroll').evaluate((node) => node.scrollTo(0, 500));
  await page.waitForTimeout(250);
  await expect(page.locator('[data-app-shell]')).toHaveClass(/is-header-hidden/);
  await expect(page.locator('[data-situation-slider]')).toBeVisible();

  await page.locator('[data-slider-situation="3"]').click();
  await expect(page.locator('[data-slider-situation="3"]')).toHaveClass(/is-active/, { timeout: 4000 });
  const activeFirst = page.locator('[data-message-situation="3"][data-situation-first="true"]');
  await expect(activeFirst).toBeVisible();

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('review-v2-mobile-dark.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(40_000);
});

test('Lena situation calibration quiz', async ({ page }, testInfo) => {
  await page.route('**/api/situation-quiz/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, quizVersion: 1, user: { role: 'Lena', email: 'lena@example.test' }, required: true, completed: false }),
    });
  });

  await page.goto('/situation-quiz.html');
  await expect(page.getByRole('heading', { name: 'Lena, lass uns herausfinden, ob du Situationen richtig erkennst' })).toBeVisible();
  await expect(page.getByText('1 / 10')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Abendessen und Versicherung' })).toBeVisible();
  expect(await page.locator('.choice').count()).toBe(2);

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('situation-quiz.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(50_000);
});
