import { expect, test } from '@playwright/test';

test('Review V2 desktop timeline stays contiguous and supports temporary split IDs', async ({ page }, testInfo) => {
  await page.goto('/review-v2-prototype.html');
  await page.locator('.rv2-shell').waitFor({ state: 'visible' });

  await expect(page.locator('.rv2-sidebar')).toBeVisible();
  await expect(page.locator('.rv2-message')).toHaveCount(21);
  await expect(page.locator('.rv2-situation-card.is-active')).toContainText('2');
  await expect(page.locator('.rv2-situation-card.is-active')).toContainText('12:41 – 13:35');
  await expect(page.locator('.rv2-situation-card.is-active')).toContainText('Klassifizierung');

  const secondMessageSituation2 = page.locator('[data-message-id="1004"]');
  await secondMessageSituation2.click();
  await expect(secondMessageSituation2.locator('[data-split-here]')).toContainText('Neue Situation ab hier');
  await secondMessageSituation2.locator('[data-split-here]').click();

  await expect(page.locator('[data-situation-id="2A"]')).toBeVisible();
  await expect(page.locator('[data-message-id="1004"]')).toHaveAttribute('data-message-situation', '2A');
  await expect(page.locator('.rv2-situation-card.is-active')).toContainText('2A');

  const contiguous = await page.evaluate(() => {
    const api = window.TRUEWORDS_REVIEW_V2_TIMELINE;
    const snapshot = window.reviewV2Prototype.snapshot();
    return api.assertContiguousSituations(snapshot.messages);
  });
  expect(contiguous).toBe(true);

  const confirmAtEnd = page.locator('[data-situation-end="2A"] [data-confirm-end]');
  await expect(confirmAtEnd).toContainText('Situation bestätigen');
  await confirmAtEnd.click();
  await expect(page.locator('[data-situation-id="2A"]')).toHaveAttribute('data-status', 'confirmed');
  await page.locator('[data-situation-end="2A"] [data-confirm-end]').click();
  await expect(page.locator('[data-situation-id="2A"]')).toHaveAttribute('data-status', 'open');

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await testInfo.attach('review-v2-timeline-desktop.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(45_000);
});

test('Review V2 mobile hides header and exposes synchronized situation slider', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/review-v2-prototype.html');
  await page.locator('.rv2-shell').waitFor({ state: 'visible' });

  await expect(page.locator('.rv2-sidebar')).toBeHidden();
  await expect(page.locator('.rv2-context-header')).toBeVisible();

  const chat = page.locator('[data-chat-scroll]');
  await chat.evaluate((node) => { node.scrollTop = 360; });
  await expect(page.locator('.rv2-shell')).toHaveClass(/is-header-hidden/);
  await expect(page.locator('.rv2-mobile-slider')).toBeVisible();

  await page.locator('[data-slider-situation="3"]').click();
  await expect.poll(() => page.evaluate(() => window.reviewV2Prototype.snapshot().activeSituationId)).toBe('3');

  const targetTop = await page.locator('[data-message-situation="3"][data-situation-first="true"]').evaluate((node) => node.getBoundingClientRect().top);
  expect(targetTop).toBeGreaterThanOrEqual(40);
  expect(targetTop).toBeLessThan(150);

  const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled' });
  await testInfo.attach('review-v2-timeline-mobile.png', { body: screenshot, contentType: 'image/png' });
  expect(screenshot.byteLength).toBeGreaterThan(35_000);
});
