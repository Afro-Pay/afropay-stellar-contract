/**
 * e2e coverage for Issue #24 — real-time escrow timeline.
 *
 *  - Live event arrival: a state change made while the page is connected
 *    animates into the timeline within ~1s.
 *  - Reconnect with replay: a raw connection is disconnected mid-stream,
 *    a state change happens while "offline", and reconnecting with
 *    `Last-Event-ID` replays exactly the missed event — nothing skipped,
 *    nothing duplicated.
 *  - Polling fallback: after 3 consecutive SSE connection failures the page
 *    shows the "Live updates unavailable" banner and switches to polling.
 *  - Accessibility: the aria-live region announces new events, verified with
 *    @axe-core/playwright.
 */

import crypto from "crypto";
import { test, expect, APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { API_BASE_URL, JWT_SECRET, TEST_ACCOUNT } from "./testConfig";
import { streamUntil, fullEventReceived } from "./sseClient";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs an HS256 JWT with the API's shared JWT_SECRET — the "integration flow" path requireSep10Ed25519 accepts. */
function signTestJwt(): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ sub: TEST_ACCOUNT, exp: Math.floor(Date.now() / 1000) + 3600 })
  );
  const signature = base64url(
    crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

async function createEscrow(api: APIRequestContext): Promise<string> {
  const res = await api.post(`${API_BASE_URL}/api/v1/escrow`, {
    data: { sender_account: TEST_ACCOUNT, corridor: "USD_NGN", amount_usdc: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.escrow_id as string;
}

async function releaseEscrow(api: APIRequestContext, escrowId: string): Promise<void> {
  const res = await api.post(`${API_BASE_URL}/api/v1/escrow/${escrowId}/release`, {
    headers: { Authorization: `Bearer ${signTestJwt()}` },
  });
  expect(res.ok()).toBeTruthy();
}

function harnessUrl(escrowId: string): string {
  return `/?escrowId=${escrowId}&apiBaseUrl=${encodeURIComponent(API_BASE_URL)}`;
}

test.describe("Escrow real-time timeline (Issue #24)", () => {
  test("live event arrival — a release made while connected animates into the timeline", async ({
    page,
    request,
  }) => {
    const escrowId = await createEscrow(request);

    await page.goto(harnessUrl(escrowId));
    await expect(page.locator(".escrow-timeline__item")).toHaveCount(1); // replayed "created" event
    await expect(page.locator('[data-mode="live"]')).toBeVisible();

    await releaseEscrow(request, escrowId);

    // New events must animate in within 500ms of being written to the store —
    // allow generous scheduling slack in CI.
    await expect(page.locator(".escrow-timeline__item")).toHaveCount(2, { timeout: 1000 });
    await expect(page.locator(".escrow-timeline__item").last()).toContainText("Released");
  });

  test("aria-live region announces new events (axe-core verified)", async ({ page, request }) => {
    const escrowId = await createEscrow(request);
    await page.goto(harnessUrl(escrowId));

    await releaseEscrow(request, escrowId);
    await expect(page.locator(".escrow-timeline__item")).toHaveCount(2);
    await expect(page.locator('[aria-live="polite"]')).toContainText("Released");

    const results = await new AxeBuilder({ page }).include(".escrow-timeline").analyze();
    expect(results.violations).toEqual([]);
  });

  test("reconnect with Last-Event-ID replays exactly the events missed while disconnected", async ({
    request,
  }) => {
    const escrowId = await createEscrow(request);

    // Initial connection: replays the "created" event. The event store's id
    // sequence is shared across all escrows (not reset per-escrow), so other
    // tests running against the same server may have already advanced it —
    // read back whatever id this escrow's first event actually got.
    const first = await streamUntil(
      `${API_BASE_URL}/api/v1/escrow/${escrowId}/stream`,
      {},
      fullEventReceived
    );
    const firstIdMatch = first.text.match(/^id: (\d+)/m);
    expect(firstIdMatch).not.toBeNull();
    const firstId = Number(firstIdMatch![1]);
    expect(first.text).toContain('"type":"created"');

    // Client goes offline (socket destroyed by streamUntil above). While
    // offline, the escrow transitions — this is the event a naive client
    // would miss.
    await releaseEscrow(request, escrowId);

    // Reconnect exactly as EventSource would: send Last-Event-ID from the
    // last event we saw.
    const second = await streamUntil(
      `${API_BASE_URL}/api/v1/escrow/${escrowId}/stream`,
      { "Last-Event-ID": String(firstId) },
      fullEventReceived
    );

    expect(second.text).toContain(`id: ${firstId + 1}`);
    expect(second.text).not.toContain(`id: ${firstId}\n`);
    expect(second.text).toContain('"state":"Released"');
  });

  test("falls back to polling and shows the unavailable banner after 3 SSE failures", async ({
    page,
    request,
  }) => {
    const escrowId = await createEscrow(request);

    let streamAttempts = 0;
    await page.route(`${API_BASE_URL}/api/v1/escrow/${escrowId}/stream`, async (route) => {
      streamAttempts += 1;
      await route.abort("connectionrefused");
    });

    await page.goto(harnessUrl(escrowId));

    await expect(page.locator(".escrow-timeline__banner")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-mode="polling"]')).toBeVisible();
    expect(streamAttempts).toBeGreaterThanOrEqual(3);
  });
});
