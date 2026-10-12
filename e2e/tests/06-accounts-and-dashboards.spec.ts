import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { newSession, users } from './helpers';

const SCREENS = join(__dirname, '..', 'results', 'screens');

test.describe('Accounts and role dashboards', () => {
  test('sign-in offers "Forgot password?" and a show-password eye', async ({ page }) => {
    await page.goto('/login');
    const password = page.getByLabel('Password', { exact: true });
    await password.fill('secret-value');
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(password).toHaveAttribute('type', 'password');

    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
    await page.getByLabel('Username or email').fill(users.employee.username);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    // Same answer whether or not the account exists (and whether email is configured).
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
    await page.screenshot({ path: join(SCREENS, 'forgot-password.png') });
  });

  test('a store manager gets a store dashboard and can open "Add staff"', async ({ browser }) => {
    const { context, page } = await newSession(browser, 'manager', {
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Store manager dashboard' })).toBeVisible();
    await page.getByRole('button', { name: 'Add staff' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a person' });
    await expect(dialog.getByLabel('Email')).toBeVisible();
    // Store managers can only add employees and security staff.
    await expect(dialog.getByLabel('Role').locator('option')).toHaveText([
      'Employee',
      'Security / Surveillance',
    ]);
    await page.screenshot({ path: join(SCREENS, 'store-manager-add-staff.png') });
    await context.close();
  });

  test('a business admin gets the business dashboard with stores and groups', async ({
    browser,
  }) => {
    const { context, page } = await newSession(browser, 'admin', {
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Business admin dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Stores' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Group chats' })).toBeVisible();
    await page.screenshot({ path: join(SCREENS, 'business-dashboard.png'), fullPage: true });

    await page.goto('/admin?tab=people');
    await page
      .getByRole('listitem')
      .filter({ hasText: users.employee.username })
      .getByRole('button', { name: 'Manage' })
      .click();
    const dialog = page.getByRole('dialog', { name: /^Manage / });
    await expect(dialog.getByRole('heading', { name: 'Role' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Set new password' })).toBeDisabled();
    await page.screenshot({ path: join(SCREENS, 'manage-person.png') });
    await context.close();
  });
});
