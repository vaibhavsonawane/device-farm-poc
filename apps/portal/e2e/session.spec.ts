import { expect, test } from '@playwright/test';
import { USERS, deviceStatus, expectLiveScreen, login, releaseAll } from './helpers';

test.beforeEach(async ({ request }) => {
  for (const email of Object.values(USERS)) await releaseAll(request, email);
});

test('login → reserve → live session → input → release', async ({ page }) => {
  await login(page, USERS.tester);
  await expect(page.getByTestId('attribution')).toHaveText(
    'Crafted by Vaibhav Sonawane through Claude',
  );
  const card = page.getByTestId('device-card-MOCK-PIXEL8-01');
  await expect(card.getByTestId('device-status')).toHaveText('Available');

  await page.getByTestId('use-MOCK-PIXEL8-01').click();
  await page.waitForURL('**/session/**');
  await expect(page.getByTestId('session-device')).toHaveText('Pixel 8');
  await expectLiveScreen(page);

  // Tap the first app icon, type into it, check the device logged both.
  const screen = page.getByTestId('screen');
  const box = (await screen.boundingBox())!;
  await screen.click({ position: { x: box.width * 0.17, y: box.height * 0.16 } });
  await page.keyboard.type('hello');
  await page.getByRole('tab', { name: 'Logs' }).click();
  await expect(page.getByTestId('log-lines')).toContainText('InputDispatcher', { timeout: 15_000 });

  // Screenshot artifact via Ctrl+S
  await screen.focus();
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/Screenshot saved/)).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('release').click();
  await page.waitForURL('**/devices');
  await expect.poll(() => deviceStatus(page, 'MOCK-PIXEL8-01')).toBe('Available');
});

test('two users drive two devices at the same time', async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await login(a, USERS.tester);
  await login(b, USERS.tester2);
  await a.getByTestId('use-MOCK-REDMI12-03').click();
  await b.getByTestId('use-MOCK-GALAXYS23-02').click();
  await a.waitForURL('**/session/**');
  await b.waitForURL('**/session/**');
  await Promise.all([expectLiveScreen(a), expectLiveScreen(b)]);
  // Each user sees the other's device as in use.
  await a.goto('/devices');
  await expect.poll(() => deviceStatus(a, 'MOCK-GALAXYS23-02')).toBe('In use');
  await a.close();
  await b.close();
});

test('a lead can watch read-only; a viewer cannot reserve', async ({ browser }) => {
  const tester = await browser.newPage();
  await login(tester, USERS.tester);
  await tester.getByTestId('use-MOCK-PIXEL8-01').click();
  await tester.waitForURL('**/session/**');
  await expectLiveScreen(tester);

  const lead = await browser.newPage();
  await login(lead, USERS.lead);
  await lead
    .getByTestId('device-card-MOCK-PIXEL8-01')
    .getByRole('button', { name: 'Watch' })
    .click();
  await lead.waitForURL('**/observe/**');
  await expect(lead.getByText('View only')).toBeVisible();
  await expectLiveScreen(lead);
  await expect(lead.getByTestId('release')).toHaveCount(0);

  const viewer = await browser.newPage();
  await login(viewer, USERS.viewer);
  await expect(viewer.getByTestId('use-MOCK-REDMI12-03')).toBeDisabled();
  await Promise.all([tester.close(), lead.close(), viewer.close()]);
});
