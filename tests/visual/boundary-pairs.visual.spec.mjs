import { test, expect } from '@playwright/test';

function fixtureMessages() {
  const base = Date.parse('2026-05-10T08:00:00Z') / 1000;
  return [
    { id: '101', from: 'Lena', t: base, text: 'Kannst du heute beim Vermieter anrufen?', kind: 'text' },
    { id: '102', from: 'Philipp', t: base + 600, text: 'Ja, mache ich in der Mittagspause.', kind: 'text' },
    { id: '103', from: 'Lena', t: base + 900, text: 'Danke dir!', kind: 'text' },
    { id: '104', from: 'Philipp', t: base + 26_000, text: 'Hat geklappt, Termin ist Donnerstag.', kind: 'text' },
    { id: '105', from: 'Lena', t: base + 26_300, text: 'Super, bis später.', kind: 'text' },
  ];
}

test('Doppelprüfung zeigt die Markieransicht mit Zwischenräumen', async ({ page }, testInfo) => {
  await page.route('**/api/rounds/1', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        round: 1,
        reviewer: 'Philipp',
        messages: fixtureMessages(),
        seams: 4,
        marks: [],
        submitted: false,
        submittedAt: null,
        otherSubmitted: false,
      }),
    });
  });

  await page.goto('/doppelpruefung.html');

  await expect(page.locator('#dp-sub')).toContainText('Philipp · Runde 1');
  await expect(page.locator('.dp-message-text').first()).toContainText('Kannst du heute beim Vermieter anrufen?');
  await expect(page.locator('.dp-seam')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Runde abgeben' })).toBeEnabled();

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('boundary-pairs-mark.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(20_000);
});

test('Ein Klick auf einen Zwischenraum markiert ihn als Grenze und speichert', async ({ page }) => {
  let savedBody = null;
  await page.route('**/api/rounds/1', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        round: 1,
        reviewer: 'Lena',
        messages: fixtureMessages(),
        seams: 4,
        marks: [],
        submitted: false,
        submittedAt: null,
        otherSubmitted: true,
      }),
    });
  });
  await page.route('**/api/rounds/1/marks', async (route) => {
    savedBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, saved: savedBody.marks.length }) });
  });

  await page.goto('/doppelpruefung.html');
  await page.locator('.dp-seam').first().click();

  await expect(page.locator('.dp-seam').first()).toHaveAttribute('data-mark', 'cut');
  await expect.poll(() => savedBody).not.toBeNull();
  expect(savedBody.marks).toEqual([{ seamMessageId: '102', mark: 'cut' }]);
});
