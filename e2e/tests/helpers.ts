import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { TOTP } from 'otpauth';

export type Person =
  'admin' | 'manager' | 'security' | 'employee' | 'colleague' | 'south' | 'platform';

export const users = JSON.parse(process.env.ALPHA_USERS ?? '{}') as Record<
  Person,
  { id: string; username: string; name: string }
>;
export const business = JSON.parse(process.env.ALPHA_BUSINESS ?? '{}') as {
  id: string;
  name: string;
  storeA: string;
};

/** Every alpha user signs in from 127.0.0.1: clear the local per-IP login budget first. */
async function clearLoginLimits(): Promise<void> {
  const redis = new Redis(process.env.ALPHA_REDIS_URL!);
  const keys = await redis.keys('rl:login:*');
  if (keys.length) await redis.del(...keys);
  redis.disconnect();
}

let lastStep = Number(process.env.ALPHA_MFA_LAST_STEP ?? 0);

/** A fresh TOTP code; waits for the next 30 s window if this one was already used (replay guard). */
async function nextTotp(): Promise<string> {
  while (Math.floor(Date.now() / 30_000) <= lastStep) await new Promise((r) => setTimeout(r, 1000));
  lastStep = Math.floor(Date.now() / 30_000);
  return new TOTP({ secret: process.env.ALPHA_ADMIN_TOTP!, digits: 6, period: 30 }).generate();
}

/** Signs in through the real login page (and the two-step screen for the admin). */
export async function signIn(page: Page, who: Person): Promise<void> {
  await clearLoginLimits();
  await page.goto('/login');
  await page.getByLabel('Username').fill(users[who].username);
  await page.getByLabel('Password', { exact: true }).fill(process.env.ALPHA_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (who === 'admin') {
    await page.getByLabel('6-digit code').fill(await nextTotp());
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
  }
  await page.waitForURL(/\/(dashboard|chats)/, { timeout: 30_000 });
}

export async function newSession(
  browser: Browser,
  who: Person,
  options: Parameters<Browser['newContext']>[0] = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await signIn(page, who);
  return { context, page };
}

/** No element may overflow the viewport horizontally (responsive layout check). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .filter((el) => ![...el.children].some((c) => c.getBoundingClientRect().right > width + 1))
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join('.')} "${(el.textContent ?? '').trim().slice(0, 40)}"`,
      );
    return { overflow: document.documentElement.scrollWidth - width, offenders };
  });
  expect(overflow, `page scrolls horizontally: ${offenders.join(' | ')}`).toBeLessThanOrEqual(1);
}

/** axe-core scan; returns serious violations and fails on critical ones. */
export async function a11y(page: Page, name: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const critical = result.violations.filter((v) => v.impact === 'critical');
  const serious = result.violations.filter((v) => v.impact === 'serious');
  expect(
    critical.map((v) => `${v.id}: ${v.nodes.length} × ${v.help}`),
    `critical accessibility violations on ${name}`,
  ).toEqual([]);
  return serious.map((v) => ({ page: name, id: v.id, nodes: v.nodes.length, help: v.help }));
}
