import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { a11y, expectNoHorizontalScroll, newSession, type Person } from './helpers';

const SCREENS = join(__dirname, '..', 'results', 'screens');
mkdirSync(SCREENS, { recursive: true });

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1440, height: 900 },
} as const;

const PAGES: Array<{ who: Person; path: string; name: string; ready: (p: Page) => Promise<void> }> =
  [
    {
      who: 'employee',
      path: '/dashboard',
      name: 'dashboard',
      ready: (p) => expect(p.getByText(/Good (morning|afternoon|evening)/)).toBeVisible(),
    },
    {
      who: 'employee',
      path: '/chats',
      name: 'chats',
      ready: (p) => expect(p.getByRole('region', { name: 'Conversations' })).toBeVisible(),
    },
    {
      who: 'employee',
      path: '/emergency',
      name: 'emergency',
      ready: (p) => expect(p.getByRole('tab', { name: 'Active' })).toBeVisible(),
    },
    {
      who: 'employee',
      path: '/settings',
      name: 'settings',
      ready: (p) => expect(p.getByRole('heading', { name: 'Notifications' })).toBeVisible(),
    },
    {
      who: 'admin',
      path: '/campaigns',
      name: 'campaigns',
      ready: (p) => expect(p.getByRole('button', { name: 'New campaign' })).toBeVisible(),
    },
    {
      who: 'admin',
      path: '/admin?tab=people',
      name: 'admin-people',
      ready: (p) => expect(p.getByRole('tab', { name: 'People' })).toBeVisible(),
    },
    {
      who: 'admin',
      path: '/admin?tab=emergency',
      name: 'admin-emergency',
      ready: (p) => expect(p.getByText('Emergency contacts')).toBeVisible(),
    },
  ];

const serious: Array<{ page: string; id: string; nodes: number; help: string }> = [];

test.afterAll(() => {
  writeFileSync(
    join(__dirname, '..', 'results', 'a11y-serious.json'),
    JSON.stringify(serious, null, 2),
  );
});

test('sign-in page is responsive and accessible', async ({ browser }) => {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto('/login');
    await expect(page.getByLabel('Username')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: join(SCREENS, `${label}-login.png`) });
    if (label === 'desktop') serious.push(...(await a11y(page, 'login')));
    await context.close();
  }
});

for (const who of ['employee', 'admin'] as const) {
  test(`${who}: every main page fits phone, tablet and desktop, in light and dark`, async ({
    browser,
  }) => {
    const pages = PAGES.filter((p) => p.who === who);
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      for (const colorScheme of ['light', 'dark'] as const) {
        if (colorScheme === 'dark' && label === 'tablet') continue;
        const { context, page } = await newSession(browser, who, { viewport, colorScheme });
        for (const target of pages) {
          await page.goto(target.path);
          await target.ready(page);
          await page.waitForTimeout(300);
          await expectNoHorizontalScroll(page);
          await page.screenshot({
            path: join(SCREENS, `${label}-${colorScheme}-${target.name}.png`),
          });
          if (label === 'desktop')
            serious.push(...(await a11y(page, `${target.name} (${colorScheme})`)));
          if (label === 'phone' && target.name === 'dashboard') {
            // Phones: bottom tabs and the SOS button are always reachable.
            await expect(page.getByRole('navigation', { name: 'Quick' })).toBeVisible();
            await expect(page.getByRole('button', { name: 'SOS' })).toBeVisible();
          }
        }
        await context.close();
      }
    }
  });
}
