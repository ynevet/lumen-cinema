/**
 * End-to-end proof of the booking flow, driven through the browser.
 *
 * The behaviour worth proving here is the part no unit test can see: that clicking a seat
 * reserves it there and then, that the countdown belongs to the selection rather than to
 * the seat, that unclicking gives a seat straight back, and that completing a reservation
 * is nothing more than Reserved becoming Booked.
 *
 * Every test registers its own account and works in a row nobody has touched, so the
 * suite can be run repeatedly against the same database.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

const PASSWORD = 'Password123!';

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.local`;
}

/** Register through the box office and wait for the auditorium to be drawn. */
async function signUp(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create one' }).click();
  await page.getByLabel('Email').fill(uniqueEmail('viewer'));
  await page.getByLabel('Name on the booking').fill('E2E Viewer');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('.seatmap')).toBeVisible();
}

/** The first row nobody has touched, so a test has a clean stretch of seats to work in. */
async function emptyRow(page: Page): Promise<Locator> {
  const rows = page.locator('.seatrow');
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if ((await row.locator('button.seat:not(.seat--available)').count()) === 0) return row;
  }
  throw new Error('No untouched row left - reset the database with `npm run docker:reset`.');
}

async function labelOf(row: Locator): Promise<string> {
  return (await row.locator('.seatrow__label').first().innerText()).trim();
}

/** The hold countdown, in seconds. */
async function secondsLeft(clock: Locator): Promise<number> {
  const text = (await clock.innerText()).trim();
  const parts = /^(\d+):(\d+)$/.exec(text);
  if (!parts) throw new Error(`Unreadable countdown: "${text}"`);
  return Number(parts[1]) * 60 + Number(parts[2]);
}

/** A second customer, working through the API rather than a second browser. */
async function rivalCustomer(request: APIRequestContext): Promise<string> {
  const response = await request.post('/api/auth/register', {
    data: { email: uniqueEmail('rival'), displayName: 'E2E Rival', password: PASSWORD },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).token as string;
}

async function rivalTakes(
  request: APIRequestContext,
  token: string,
  rowLabel: string,
  seatNumbers: number[],
): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };

  // The client always opens on the next showing, which is the first one the API lists.
  const listed = await (await request.get('/api/screenings', { headers })).json();
  const screeningId = listed.screenings[0].id;

  const map = await (
    await request.get(`/api/screenings/${screeningId}/seatmap`, { headers })
  ).json();
  const row = map.rows.find((item: { label: string }) => item.label === rowLabel);
  const seatIds = seatNumbers.map(
    (number) => row.seats.find((seat: { seatNumber: number }) => seat.seatNumber === number).id,
  );

  const held = await request.post(`/api/screenings/${screeningId}/reservations`, {
    headers,
    data: { seatIds },
  });
  expect(held.status()).toBe(201);
}

test('reserves a seat the moment it is clicked, and books the selection', async ({ page }) => {
  await signUp(page);

  const row = await emptyRow(page);
  const seats = row.locator('button.seat');

  // Selecting is reserving: there is no separate submit step to reach.
  await seats.nth(0).click();
  await expect(seats.nth(0)).toHaveClass(/seat--selected/);

  const clock = page.locator('.clock');
  await expect(clock).toBeVisible();
  const started = await secondsLeft(clock);
  expect(started).toBeLessThanOrEqual(15 * 60);
  expect(started).toBeGreaterThan(14 * 60);

  // One clock for the whole selection, running from the first seat: adding a second seat
  // extends the selection but must not buy the customer more time.
  await page.waitForTimeout(3000);
  await seats.nth(1).click();
  await expect(seats.nth(1)).toHaveClass(/seat--selected/);
  expect(await secondsLeft(clock)).toBeLessThan(started - 1);

  // Unclicking puts a seat straight back on sale - no expiry to wait for.
  await seats.nth(1).click();
  await expect(seats.nth(1)).toHaveClass(/seat--available/);
  await expect(row.locator('.seat--selected')).toHaveCount(1);

  // Completing the reservation is exactly Reserved -> Booked, and nothing else.
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.locator('.hold--booked')).toBeVisible();
  await expect(seats.nth(0)).toHaveClass(/seat--mine-booked/);
});

test('shows what somebody else has taken, and says why a seat is refused', async ({
  page,
  request,
}) => {
  const rival = await rivalCustomer(request);
  await signUp(page);

  const row = await emptyRow(page);
  const rowLabel = await labelOf(row);
  await rivalTakes(request, rival, rowLabel, [1, 2]);

  // No live updating is promised, so re-read the map the way a customer would.
  await page.reload();
  const seats = row.locator('button.seat');
  await expect(seats.nth(0)).toHaveClass(/seat--reserved/);
  await expect(seats.nth(0)).toBeDisabled();

  // Seat 4 is free, but taking it would maroon seat 3 between two occupied seats. The
  // server has the last word on that, and the reason reaches the customer.
  await seats.nth(3).click();
  const toast = page.locator('.toast--error');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('strand');
  await expect(seats.nth(3)).not.toHaveClass(/seat--selected/);
});
