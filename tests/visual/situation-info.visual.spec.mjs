import { test, expect } from '@playwright/test';

test('Situationsinfo erklärt Konversation, asynchrone Pausen und V4', async ({ page }, testInfo) => {
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

  await expect(page.getByRole('heading', { name: 'Situation bedeutet Konversation.' })).toBeVisible();
  await expect(page.locator('.definition-quote')).toContainText('Situation = Konversation');
  await expect(page.getByText('Zeitpause ≠ Grenze')).toBeVisible();
  await expect(page.getByText('Thema ≠ Situation')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vier Stunden Antwortpause können eine Situation bleiben' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'TrueWords V4 setzt diese Regel erstmals direkt um' })).toBeVisible();
  await expect(page.getByText(/externe Sprach-KI erzeugt die Grenzen nicht/i)).toBeVisible();
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
      body: JSON.stringify({ ok: true, user: { email: 'lena@example.test', role: 'Lena', canUpload: false } }),
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
