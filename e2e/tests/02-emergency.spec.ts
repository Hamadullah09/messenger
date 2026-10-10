import { expect, test } from '@playwright/test';
import { newSession } from './helpers';

test.describe('Emergency help', () => {
  test('alert → full-screen alert for the manager → responding → resolved, without leaking contact details', async ({
    browser,
  }) => {
    const manager = await newSession(browser, 'manager');
    const security = await newSession(browser, 'security');
    const employee = await newSession(browser, 'employee');

    // Raise the alert.
    await employee.page.getByRole('button', { name: 'Emergency help' }).first().click();
    const dialog = employee.page.getByRole('dialog', { name: 'Emergency help' });
    await expect(dialog.getByText('call your local emergency number first')).toBeVisible();
    await dialog.getByRole('button', { name: 'Medical' }).click();
    await dialog.getByLabel('What is happening? (optional)').fill('Customer fainted at checkout 2');
    await dialog.getByRole('button', { name: 'Send emergency alert' }).click();
    await employee.page.waitForURL(/\/emergency\?id=/);
    await expect(employee.page.getByText('Waiting for response').first()).toBeVisible();

    // Security on shift sees a banner (not the full-screen alert).
    await expect(
      security.page.getByRole('status').filter({ hasText: 'Emergency at QA Store North' }),
    ).toBeVisible();
    await expect(security.page.getByRole('alertdialog')).toHaveCount(0);

    // The manager is alerted on whatever screen they are on.
    const alert = manager.page.getByRole('alertdialog');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Medical · QA Store North');
    await expect(alert).toContainText('Alpha Employee');
    await expect(alert).toContainText('Customer fainted at checkout 2');
    await alert.getByRole('button', { name: /I.m responding/ }).click();
    await manager.page.waitForURL(/\/emergency\?id=/);
    await expect(manager.page.getByText('Help is on the way').first()).toBeVisible();

    // The employee sees the response live.
    await expect(employee.page.getByText('Help is on the way').first()).toBeVisible();
    await expect(employee.page.getByText('Alpha Manager is responding').first()).toBeVisible();

    // Nobody's private contact details appear anywhere.
    for (const page of [employee.page, manager.page, security.page]) {
      const html = await page.content();
      expect(html).not.toContain('@example.com');
      expect(html).not.toContain('+15555550142');
    }

    // The emergency conversation opens from the incident.
    await manager.page.getByRole('link', { name: 'Open conversation' }).click();
    await expect(manager.page.getByText('Emergency conversation').first()).toBeVisible();
    await manager.page.goBack();

    // Resolve with a note.
    await manager.page.getByRole('button', { name: 'Mark resolved' }).click();
    const resolve = manager.page.getByRole('dialog', { name: 'Mark as resolved' });
    await resolve.getByLabel('What happened? (optional)').fill('Paramedics took over');
    await resolve.getByRole('button', { name: 'Mark resolved' }).click();
    await expect(manager.page.getByText('Resolved').first()).toBeVisible();
    await expect(employee.page.getByText(/Resolved by Alpha Manager/)).toBeVisible();

    for (const s of [manager, security, employee]) await s.context.close();
  });

  test('the store admin configures emergency contacts', async ({ browser }) => {
    const admin = await newSession(browser, 'admin');
    await admin.page.goto('/admin?tab=emergency');
    await admin.page.getByLabel('Store').selectOption({ label: 'QA Store North' });
    await expect(admin.page.getByText('No contacts set')).toBeVisible();
    await admin.page.getByLabel('Add a contact').selectOption({ label: 'Alpha Security' });
    await admin.page.getByRole('button', { name: 'Add', exact: true }).click();
    await admin.page.getByLabel('Add a contact').selectOption({ label: 'Alpha Manager' });
    await admin.page.getByRole('button', { name: 'Add', exact: true }).click();
    await admin.page.getByLabel('Time to respond').selectOption({ label: '1 minute' });
    await admin.page.getByRole('button', { name: 'Save changes' }).click();
    await expect(admin.page.getByText('Emergency settings saved.')).toBeVisible();
    const list = admin.page.locator('ol').first();
    await expect(list.locator('li').nth(0)).toContainText('Primary');
    await expect(list.locator('li').nth(0)).toContainText('Alpha Security');
    await expect(list.locator('li').nth(1)).toContainText('Alpha Manager');
    await admin.context.close();
  });
});
