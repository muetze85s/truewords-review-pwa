import { test, expect } from '@playwright/test';

test('Login zeigt die V4-Konversationsdefinition im Bento-Layout', async ({ page }, testInfo) => {
  await page.route('**/api/auth/setup-status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, configured: true }) });
  });
  await page.goto('/login.html');
  await expect(page.getByRole('heading', { name: 'Konversationen sauber voneinander trennen.' })).toBeVisible();
  await expect(page.getByText('Situation = Konversation')).toBeVisible();
  await expect(page.getByText('Zeit ist nur Indiz')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('login-v4.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(25_000);
});

test('Upload zeigt Test 4 und benötigt nur noch den Originalexport', async ({ page }, testInfo) => {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, user: { email: 'philipp@example.test', role: 'Philipp', canUpload: true } }) });
  });
  await page.goto('/upload.html');
  await expect(page.getByRole('heading', { name: 'V4 auf einem neuen ungesehenen Abschnitt prüfen.' })).toBeVisible();
  await expect(page.getByText('Situation = Konversation · Zeitabstand allein erzeugt keine Grenze')).toBeVisible();
  await expect(page.locator('#raw-file')).toBeVisible();
  await expect(page.locator('#preselection-file')).toHaveCount(0);
  await expect(page.getByText('Test 3 bleibt unverändert erhalten')).toBeVisible();
  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await testInfo.attach('upload-v4.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(25_000);
});
