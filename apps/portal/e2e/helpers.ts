import { type APIRequestContext, type Page, expect } from '@playwright/test';

export const PASSWORD = process.env.E2E_PASSWORD ?? 'DeviceLab@2026';
export const USERS = {
  tester: 'tester@devicelab.local',
  tester2: 'tester2@devicelab.local',
  lead: 'lead@devicelab.local',
  viewer: 'viewer@devicelab.local',
} as const;

const API = 'http://localhost:3000/api';

const tokens = new Map<string, string>();

async function apiToken(request: APIRequestContext, email: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok(), `API login for ${email}: HTTP ${res.status()}`).toBeTruthy();
  const { accessToken } = (await res.json()) as { accessToken: string };
  tokens.set(email, accessToken);
  return accessToken;
}

/** Release every active reservation the user holds so each test starts clean. */
export async function releaseAll(request: APIRequestContext, email: string): Promise<void> {
  const headers = { Authorization: `Bearer ${await apiToken(request, email)}` };
  const res = await request.get(`${API}/reservations?scope=mine`, { headers });
  for (const r of (await res.json()) as { id: string; status: string }[]) {
    if (r.status === 'ACTIVE')
      await request.post(`${API}/reservations/${r.id}/release`, { headers });
  }
}

export async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/devices');
}

/** Wait until the viewer has decoded frames and the canvas is not blank. */
export async function expectLiveScreen(page: Page): Promise<void> {
  await expect(page.getByTestId('stream-stats')).not.toHaveText(/^0 fps/, { timeout: 20_000 });
  const lit = await page.getByTestId('screen-canvas').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx || !c.width) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4 * 97) sum += data[i]! + data[i + 1]! + data[i + 2]!;
    return sum;
  });
  expect(lit).toBeGreaterThan(0);
}

export async function deviceStatus(page: Page, udid: string): Promise<string> {
  return (
    (await page.getByTestId(`device-card-${udid}`).getByTestId('device-status').textContent()) ?? ''
  );
}
