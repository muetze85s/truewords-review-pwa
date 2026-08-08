import { test, expect } from '@playwright/test';

test('Situationsinfo erklärt Gesprächsepisode und Algorithmus', async ({ page }, testInfo) => {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        user: { email: 'philipp@example.test', role: 'Philipp', canUpload: true },
      }),
    });
  });

  await page.goto('/situation-info.html');

  await expect(page.getByRole('heading', { name: 'Was TrueWords mit „Situation“ meint' })).toBeVisible();
  await expect(page.locator('.definition-quote')).toContainText('Situation = zusammenhängende Gesprächsepisode');
  await expect(page.getByText('Situation ≠ Thema')).toBeVisible();
  await expect(page.getByText('Pause ≠ automatisch Ende')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Die Grenzen kommen vom TrueWords-Algorithmus' })).toBeVisible();
  await expect(page.getByText(/externe Sprach-KI soll die Situationsgrenzen nicht festlegen/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zum Prüfstand' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Daten / Upload' })).toBeVisible();

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('situation-info.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(40_000);
});

test('Lena wird von der Situationsinfo zuerst zum Quiz geführt', async ({ page }) => {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        user: { email: 'lena@example.test', role: 'Lena', canUpload: false },
      }),
    });
  });
  await page.route('**/api/situation-quiz/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, required: true, completed: false }),
    });
  });

  await page.goto('/situation-info.html');
  await expect(page.getByRole('button', { name: 'Zum kurzen Situations-Quiz' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Daten / Upload' })).toBeHidden();
});
