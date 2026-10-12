import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { newSession, signIn, users } from './helpers';

test.describe('Sign-in and app shell', () => {
  test('rejects a wrong password without revealing which part was wrong', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByLabel('Username').fill(users.employee.username);
    await page.getByLabel('Password', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Incorrect username or password')).toBeVisible();
  });

  test('an employee lands on the dashboard with navigation and the emergency button', async ({
    page,
  }) => {
    await signIn(page, 'employee');
    await expect(page.getByRole('button', { name: 'Emergency help' }).first()).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' }).first();
    await expect(nav.getByRole('link', { name: 'Messages' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Emergency' })).toBeVisible();
    // Staff do not see administration features.
    await expect(nav.getByRole('link', { name: 'Campaigns' })).toHaveCount(0);
  });

  test('the admin signs in with two-step verification and sees administration', async ({
    page,
  }) => {
    await signIn(page, 'admin');
    const nav = page.getByRole('navigation', { name: 'Main' }).first();
    await expect(nav.getByRole('link', { name: 'Campaigns' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Emergency setup' })).toBeVisible();
  });
});

test.describe('Messaging', () => {
  test('a platform admin can message people in any business', async ({ page }) => {
    await signIn(page, 'platform');
    await page.goto('/chats');
    await page.getByRole('button', { name: 'Start a new conversation' }).click();
    await page.getByRole('menuitem', { name: 'New chat' }).click();
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await expect(dialog.getByLabel('Search people')).toBeVisible();
    await expect(dialog.getByText('No one to message from this account')).toHaveCount(0);
  });

  test('two colleagues chat in real time, with a photo', async ({ browser }) => {
    const a = await newSession(browser, 'employee');
    const b = await newSession(browser, 'colleague');

    await a.page.goto('/chats');
    await a.page.getByRole('button', { name: 'Start a new conversation' }).click();
    await a.page.getByRole('menuitem', { name: 'New chat' }).click();
    await a.page.getByLabel('Search people').fill('Alpha Colleague');
    await a.page.getByRole('button', { name: /Alpha Colleague/ }).click();
    const log = (p: typeof a.page) => p.getByRole('log', { name: 'Messages' });
    const text = `Alpha hello ${Date.now()}`;
    await a.page.getByPlaceholder('Type a message…').fill(text);
    await a.page.getByRole('button', { name: 'Send' }).click();
    await expect(log(a.page).getByText(text)).toBeVisible();

    // The colleague receives it live (no reload) and replies.
    await b.page.goto('/chats');
    await b.page
      .getByRole('button', { name: /Alpha Employee/ })
      .first()
      .click();
    await expect(log(b.page).getByText(text)).toBeVisible();
    await b.page.getByPlaceholder('Type a message…').fill('Got it 👍');
    await b.page.keyboard.press('Enter');
    await expect(log(a.page).getByText('Got it 👍')).toBeVisible();

    // A photo goes through upload → safety check → delivery.
    const png = await sharp({
      create: { width: 320, height: 200, channels: 3, background: '#c2410c' },
    })
      .png()
      .toBuffer();
    await a.page.locator('input[type="file"]').first().setInputFiles({
      name: 'alpha-shelf.png',
      mimeType: 'image/png',
      buffer: png,
    });
    await a.page.getByPlaceholder('Add a caption (optional)').fill('Shelf photo');
    await a.page.getByRole('button', { name: 'Send' }).click();
    await expect(b.page.getByRole('img', { name: 'Photo: alpha-shelf.png' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(log(b.page).getByText('Shelf photo')).toBeVisible();

    await a.context.close();
    await b.context.close();
  });
});
