import { expect, test } from '@playwright/test';

function fixture() {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    id: 401 + index,
    date: `2026-05-10T${String(8 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '05' : '00'}:00Z`,
    date_unixtime: String(1778400000 + index * 300),
    from: index % 2 ? 'Lena' : 'Philipp',
    text: `Nachricht ${index + 1} für den Split-Viewport-Test.`,
  }));
  return {
    ok: true,
    user: { id: 1, email: 'philipp@example.test', role: 'Philipp', canUpload: true },
    dataset: { id: 'split-viewport-fixture', name: 'Split Viewport Fixture', year: 2026, revision: 1 },
    owners: { '1': 'Philipp', '2': 'Philipp' },
    annotations: {
      schemaVersion: 'truewords-manual-segmentation/v4-unseen',
      situations: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }],
      assignments: Object.fromEntries(messages.map((message, index) => [String(message.id), index < 7 ? 1 : 2])),
      events: [],
      testFilter: { schemaVersion: 'truewords-test-filter/v1', selection: { eventIds: messages.map((message) => message.id) } },
    },
    messages,
    replyMessages: [],
    window: { messages: messages.length, assigned: messages.length, situations: 2, exactTestFilter: true },
  };
}

async function mockReview(page) {
  const current = structuredClone(fixture());
  let revision = 1;
  await page.route('**/api/auth/me', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, user: current.user }),
  }));
  await page.route('**/api/review/bootstrap', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(current),
  }));
  await page.route('**/api/state**', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.annotations) {
        current.annotations = structuredClone(body.annotations);
        for (const situation of current.annotations.situations || []) {
          if (!current.owners[String(situation.id)]) current.owners[String(situation.id)] = 'Philipp';
        }
      }
      revision += 1;
      current.dataset.revision = revision;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revision }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.route('**/api/auth/logout', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
}

test('Neue Situation ab hier stellt nach Reload Nachricht, Auswahl und Viewport wieder her', async ({ page }) => {
  await mockReview(page);
  await page.goto('/review.html');
  await page.locator('.tw-workspace').waitFor({ state: 'visible' });

  await page.locator('[data-chat-scroll]').evaluate((scroll) => {
    const node = scroll.querySelector('[data-message-wrap="405"]');
    if (node) scroll.scrollTop = Math.max(0, node.offsetTop - 260);
  });
  await page.locator('[data-message-id="405"]').click();
  await expect(page.locator('[data-message-wrap="405"]')).toHaveClass(/is-selected/);
  const beforeTop = await page.locator('[data-message-wrap="405"]').evaluate((node) => node.getBoundingClientRect().top);

  await page.getByRole('button', { name: 'Neue Situation ab hier' }).click();
  await expect(page.locator('[data-situation-list]')).toContainText('1A', { timeout: 8000 });
  await expect(page.locator('[data-situation-list] [data-situation-card="3"]')).toHaveClass(/is-active/);
  await expect(page.locator('[data-message-wrap="405"]')).toHaveClass(/is-selected/);

  const afterTop = await page.locator('[data-message-wrap="405"]').evaluate((node) => node.getBoundingClientRect().top);
  expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(8);
});
