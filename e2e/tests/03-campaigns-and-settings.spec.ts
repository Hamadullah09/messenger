import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { business, newSession } from './helpers';

test.describe('Bulk campaigns', () => {
  test('admin sends an announcement; staff receive it read-only; report exports', async ({
    browser,
  }) => {
    const admin = await newSession(browser, 'admin');
    const employee = await newSession(browser, 'employee');

    await admin.page
      .getByRole('navigation', { name: 'Main' })
      .first()
      .getByRole('link', { name: 'Campaigns' })
      .click();
    await admin.page.getByRole('button', { name: 'New campaign' }).click();
    await admin.page.getByLabel('Campaign name').fill('Alpha stock count');
    await admin.page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('All stores close at 4 pm on Friday for the stock count.');
    await admin.page.getByRole('button', { name: 'Save draft' }).click();

    // Preview: counts only. 5 staff besides the sender.
    await expect(admin.page.getByText(/5\s+people will receive this/)).toBeVisible();
    await admin.page.getByRole('button', { name: 'Send now' }).click();
    const confirm = admin.page.getByRole('dialog', { name: 'Send campaign now?' });
    await confirm.getByRole('button', { name: 'Send to 5 people' }).click();
    await expect(admin.page.getByText('Completed').first()).toBeVisible({ timeout: 30_000 });
    await expect(
      admin.page.getByRole('button', { name: /Sent\s*\d|Delivered\s*\d|Saved\s*\d/ }).first(),
    ).toBeVisible();

    // The employee gets it in a read-only Announcements chat.
    await employee.page.goto('/chats');
    await employee.page
      .getByRole('button', { name: new RegExp(`Announcements · ${business.name}`) })
      .click();
    const log = employee.page.getByRole('log', { name: 'Messages' });
    await expect(log.getByText('All stores close at 4 pm on Friday')).toBeVisible();
    await expect(
      employee.page.getByText('Announcements are one-way. Replies are turned off.'),
    ).toBeVisible();

    // Delivery report as CSV.
    const download = admin.page.waitForEvent('download');
    await admin.page.getByRole('button', { name: 'Export report (CSV)' }).click();
    const file = await (await download).path();
    const csv = readFileSync(file, 'utf8');
    expect(csv).toContain('username,display_name,status,reason,processed_at');
    expect(csv).toContain('Alpha Employee');
    expect(csv).not.toContain('@example.com');

    // Do-not-send list.
    await admin.page.getByRole('button', { name: 'Do-not-send list' }).click();
    const list = admin.page.getByRole('dialog', { name: 'Do-not-send list' });
    await list.getByLabel('Add a person').selectOption({ label: 'Alpha South' });
    await list.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(list.getByText('Added by an admin')).toBeVisible();

    await admin.context.close();
    await employee.context.close();
  });
});

test.describe('Settings and devices', () => {
  test('notification preferences persist and another device can be signed out', async ({
    browser,
  }) => {
    const main = await newSession(browser, 'colleague');
    const other = await newSession(browser, 'colleague');

    await main.page.goto('/settings');
    await expect(main.page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(main.page.getByRole('button', { name: 'Turn on notifications' })).toBeVisible();
    const preview = main.page.getByLabel('What notifications show on the lock screen');
    await expect(preview).toHaveValue('NONE');
    await preview.selectOption('SENDER');
    await main.page.waitForTimeout(500);
    await main.page.reload();
    await expect(main.page.getByLabel('What notifications show on the lock screen')).toHaveValue(
      'SENDER',
    );
    await expect(main.page.getByText(/Emergency alerts always notify your devices/)).toBeVisible();

    // Sign the other browser out from here; it is sent back to the sign-in page.
    const devices = main.page
      .getByRole('heading', { name: 'Signed-in devices' })
      .locator('xpath=ancestor::section[1]');
    await devices.getByRole('button', { name: 'Sign out' }).first().click();
    await expect(other.page).toHaveURL(/\/login/, { timeout: 20_000 });

    await main.context.close();
    await other.context.close();
  });
});
