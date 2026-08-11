import { expect, test } from '@playwright/test';

test('Review V2 situation cards reserve expandable analysis details', async ({ page }, testInfo) => {
  await page.goto('/tests/visual/review-v2-situation-fixture.html');
  await page.locator('.rv2-situation-card').first().waitFor({ state: 'visible' });

  const cards = page.locator('.rv2-situation-card');
  await expect(cards).toHaveCount(4);

  const active = cards.first();
  const inactive = cards.nth(1);

  await expect(active).toContainText('2');
  await expect(active).toContainText('bestätigt');
  await expect(active).toContainText('16 Nachr.');
  await expect(active).toContainText('Philipp');
  await expect(active).toContainText('01.05.');
  await expect(active).toContainText('Klassifizierung');
  await expect(active).toContainText('Richtung');
  await expect(active).toContainText('Muster');
  await expect(active).toContainText('Späteres Analysefeld');
  await expect(active.locator('[data-edit-detail]')).toHaveCount(7);

  await expect(inactive).toContainText('3');
  await expect(inactive).toContainText('7 Nachr.');
  await expect(inactive).toContainText('Lena');
  await expect(inactive).toContainText('02.05.');
  await expect(inactive).not.toContainText('offen');
  await expect(inactive.locator('.rv2-details')).toHaveCount(0);

  const [activeHeight, inactiveHeight] = await Promise.all([
    active.evaluate((node) => node.getBoundingClientRect().height),
    inactive.evaluate((node) => node.getBoundingClientRect().height),
  ]);
  expect(activeHeight).toBeGreaterThan(inactiveHeight + 40);

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await testInfo.attach('review-v2-situation-cards.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(30_000);
});
