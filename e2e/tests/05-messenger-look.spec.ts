import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { newSession } from './helpers';

const SCREENS = join(__dirname, '..', 'results', 'screens');

test.describe('WhatsApp Web-style messenger', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`an open chat shows bubbles with time and ticks inside (${scheme})`, async ({
      browser,
    }) => {
      const a = await newSession(browser, 'employee', {
        viewport: { width: 1440, height: 900 },
        colorScheme: scheme,
      });
      await a.page.goto('/chats');
      await a.page.getByRole('button', { name: 'Start a new conversation' }).click();
      await a.page.getByRole('menuitem', { name: 'New chat' }).click();
      const dialog = a.page.getByRole('dialog', { name: 'New chat' });
      await dialog.getByLabel('Search people').fill('Alpha Colleague');
      await dialog.getByRole('button', { name: /Alpha Colleague/ }).click();
      const text = `Looks like WhatsApp ${scheme} ${Date.now()}`;
      await a.page.getByPlaceholder('Type a message…').fill(text);
      await a.page.keyboard.press('Enter');

      const log = a.page.getByRole('log', { name: 'Messages' });
      const bubble = log.getByRole('article').filter({ hasText: text });
      await expect(bubble).toBeVisible();
      // Time and delivery ticks sit inside the bubble.
      await expect(bubble.locator('time')).toBeVisible();
      await expect(bubble.getByText(/^(Sent|Delivered|Read|Queued|Sending)$/)).toHaveCount(1);
      await a.page.screenshot({ path: join(SCREENS, `desktop-${scheme}-open-chat.png`) });

      await a.page.setViewportSize({ width: 390, height: 844 });
      await expect(bubble).toBeVisible();
      await a.page.screenshot({ path: join(SCREENS, `phone-${scheme}-open-chat.png`) });
      await a.context.close();
    });
  }
});
