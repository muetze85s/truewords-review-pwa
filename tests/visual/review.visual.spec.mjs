import { expect, test } from '@playwright/test';

const cases = [
  { theme: 'dark', snapshot: 'review-dark.png' },
  { theme: 'light', snapshot: 'review-light.png' },
];

for (const visualCase of cases) {
  test(`review design ${visualCase.theme}`, async ({ page }) => {
    await page.goto(`/tests/visual/review-fixture.html?theme=${visualCase.theme}`);
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: visualCase.theme });

    const philipp = page.locator('.message.assigned[data-speaker="Philipp"]').first();
    const lena = page.locator('.message.assigned[data-speaker="Lena"]').first();
    const context = page.locator('.message.context[data-speaker="Philipp"]').first();
    const body = page.locator('body');

    const [philippBg, lenaBg, contextBg, bodyBg, contextOpacity] = await Promise.all([
      philipp.evaluate((node) => getComputedStyle(node).backgroundColor),
      lena.evaluate((node) => getComputedStyle(node).backgroundColor),
      context.evaluate((node) => getComputedStyle(node).backgroundColor),
      body.evaluate((node) => getComputedStyle(node).backgroundColor),
      context.evaluate((node) => Number(getComputedStyle(node).opacity)),
    ]);

    expect(philippBg).not.toBe(bodyBg);
    expect(lenaBg).not.toBe(bodyBg);
    expect(philippBg).not.toBe(lenaBg);
    expect(contextBg).not.toBe(bodyBg);
    expect(contextOpacity).toBeLessThan(1);

    const statusBackgrounds = await page.locator('.situation-row').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).backgroundColor),
    );
    expect(new Set(statusBackgrounds).size).toBeGreaterThanOrEqual(4);

    const confirmButton = page.locator('.review-actions button.confirm');
    const buttonBackground = await confirmButton.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(buttonBackground).not.toBe(bodyBg);

    await expect(page).toHaveScreenshot(visualCase.snapshot, {
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
  });
}
