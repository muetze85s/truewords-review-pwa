import { expect, test } from '@playwright/test';

const cases = [
  { theme: 'dark', screenshot: 'review-dark.png' },
  { theme: 'light', screenshot: 'review-light.png' },
];

async function resolvedColor(page, variableName) {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = `var(${name})`;
    probe.style.position = 'fixed';
    probe.style.opacity = '0';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, variableName);
}

for (const visualCase of cases) {
  test(`review design ${visualCase.theme}`, async ({ page }, testInfo) => {
    await page.goto(`/tests/visual/review-fixture.html?theme=${visualCase.theme}`);
    await page.addStyleTag({ url: '/truewords-ui-bright.css' });
    await page.locator('.app-shell').waitFor({ state: 'visible' });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: visualCase.theme });

    const philipp = page.locator('.message.assigned[data-speaker="Philipp"]').first();
    const lena = page.locator('.message.assigned[data-speaker="Lena"]').first();
    const context = page.locator('.message.context[data-speaker="Philipp"]').first();
    const body = page.locator('body');
    const panel = page.locator('.panel').first();

    const [
      philippBg,
      lenaBg,
      contextBg,
      bodyBg,
      panelBg,
      contextOpacity,
      philippBorder,
      lenaBorder,
      philippToken,
      lenaToken,
    ] = await Promise.all([
      philipp.evaluate((node) => getComputedStyle(node).backgroundColor),
      lena.evaluate((node) => getComputedStyle(node).backgroundColor),
      context.evaluate((node) => getComputedStyle(node).backgroundColor),
      body.evaluate((node) => getComputedStyle(node).backgroundColor),
      panel.evaluate((node) => getComputedStyle(node).backgroundColor),
      context.evaluate((node) => Number(getComputedStyle(node).opacity)),
      philipp.evaluate((node) => getComputedStyle(node).borderColor),
      lena.evaluate((node) => getComputedStyle(node).borderColor),
      resolvedColor(page, '--tw-philipp-surface'),
      resolvedColor(page, '--tw-lena-surface'),
    ]);

    expect(bodyBg).not.toBe(panelBg);
    expect(philippBg).toBe(philippToken);
    expect(lenaBg).toBe(lenaToken);
    expect(philippBg).not.toBe(bodyBg);
    expect(lenaBg).not.toBe(bodyBg);
    expect(philippBg).not.toBe(lenaBg);
    expect(contextBg).not.toBe(bodyBg);
    expect(contextOpacity).toBeLessThan(1);
    expect(philippBorder).toBe(lenaBorder);
    expect(philippBorder).not.toBe('rgba(0, 0, 0, 0)');

    const statusBackgrounds = await page.locator('.situation-row').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).backgroundColor),
    );
    expect(new Set(statusBackgrounds).size).toBeGreaterThanOrEqual(4);

    const confirmButton = page.locator('.review-actions button.confirm');
    const buttonBackground = await confirmButton.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(buttonBackground).not.toBe(bodyBg);

    const screenshot = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
    });
    await testInfo.attach(visualCase.screenshot, {
      body: screenshot,
      contentType: 'image/png',
    });
    expect(screenshot.byteLength).toBeGreaterThan(50_000);
  });
}

test('Lena situation calibration quiz', async ({ page }, testInfo) => {
  await page.route('**/api/situation-quiz/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        quizVersion: 1,
        user: { role: 'Lena', email: 'lena@example.test' },
        required: true,
        completed: false,
      }),
    });
  });

  await page.goto('/situation-quiz.html');
  await expect(page.getByRole('heading', {
    name: 'Lena, Lass uns herausfinden ob du Situation richtig erkennst',
  })).toBeVisible();
  await expect(page.getByText('1 / 10')).toBeVisible();
  await expect(page.getByRole('heading', {
    name: 'Organisation – plötzlich ein altes Thema',
  })).toBeVisible();

  const philipp = page.locator('.chat-line.philipp').first();
  const lena = page.locator('.chat-line.lena').first();
  const [philippBg, lenaBg] = await Promise.all([
    philipp.evaluate((node) => getComputedStyle(node).backgroundColor),
    lena.evaluate((node) => getComputedStyle(node).backgroundColor),
  ]);
  expect(philippBg).not.toBe(lenaBg);
  expect(await page.locator('.choice').count()).toBe(2);

  const screenshot = await page.screenshot({
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  await testInfo.attach('situation-quiz.png', {
    body: screenshot,
    contentType: 'image/png',
  });
  expect(screenshot.byteLength).toBeGreaterThan(50_000);
});
