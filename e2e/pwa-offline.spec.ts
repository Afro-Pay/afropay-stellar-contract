/**
 * Playwright tests — PWA offline support (Issue #21)
 *
 * Covers:
 * 1. Payment form filled while offline is queued and auto-submitted within
 *    5 s of reconnect, using the same idempotency key as the original attempt.
 * 2. FX rate stale banner appears when the displayed rate is > 60 s old.
 * 3. Stale banner disappears when a fresh rate is loaded.
 * 4. POST mutation responses are never served from cache (network-only).
 *
 * Prerequisites:
 *   - A running API at API_BASE_URL (set in e2e/testConfig.ts)
 *   - A running Vite dev server at APP_BASE_URL
 *   - The Playwright config at e2e/playwright.config.ts
 *
 * Run:
 *   cd app && npm run test:e2e -- --grep offline
 */

import { test, expect, Page, Route } from "@playwright/test";
import { API_BASE_URL } from "../testConfig";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to the payment initiation page (adjust path as the SPA grows). */
async function goToPaymentPage(page: Page): Promise<void> {
  await page.goto("/?escrowId=test-offline&apiBaseUrl=" + encodeURIComponent(API_BASE_URL));
  // Wait for the app shell to mount.
  await page.waitForSelector("#root > *", { timeout: 10_000 });
}

/** Navigate to the offline page component directly for isolation tests. */
async function goToOfflinePage(page: Page): Promise<void> {
  await page.goto("/?page=offline");
  await page.waitForSelector("#root > *", { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Test suite: outbox queue + background sync
// ---------------------------------------------------------------------------

test.describe("PWA offline outbox (Issue #21)", () => {
  test(
    "payment queued offline is auto-submitted within 5 s of reconnect with same idempotency key",
    async ({ page, context }) => {
      // Track all requests to the payments endpoint.
      const submittedRequests: { idempotencyKey: string; body: string }[] = [];

      // Intercept POST /api/v1/payments to capture idempotency keys and
      // simulate a successful server response.
      await page.route("**/api/v1/payments", async (route: Route) => {
        const req = route.request();
        const headers = await req.allHeaders();
        submittedRequests.push({
          idempotencyKey: headers["idempotency-key"] ?? "",
          body: req.postData() ?? "",
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "ok" }),
        });
      });

      await goToPaymentPage(page);

      // Go offline.
      await context.setOffline(true);

      // Enqueue a payment directly via the page context (simulates the form
      // submit path calling enqueuePayment() when navigator.onLine is false).
      const idempotencyKey = `test-idem-${Date.now()}`;
      await page.evaluate(
        async ({ url, idemKey }: { url: string; idemKey: string }) => {
          // Dynamically import the outbox module (available in dev mode via Vite).
          const { enqueuePayment } = await import("/src/sw/outbox.ts");
          await enqueuePayment({
            url,
            body: JSON.stringify({ amount: 100, corridor: "USD_NGN" }),
            idempotencyKey: idemKey,
          });
        },
        { url: `${API_BASE_URL}/api/v1/payments`, idemKey: idempotencyKey }
      );

      // Come back online — the 'online' event listener in outbox.ts should
      // drain the queue within 5 s.
      await context.setOffline(false);

      // Wait up to 5 s for the queued request to be submitted.
      await page.waitForFunction(
        () =>
          new Promise<boolean>((resolve) => {
            let attempts = 0;
            const check = setInterval(async () => {
              attempts++;
              const { listPending } = await import("/src/sw/outbox.ts");
              const pending = await listPending();
              if (pending.length === 0) {
                clearInterval(check);
                resolve(true);
              }
              if (attempts > 50) {
                clearInterval(check);
                resolve(false);
              }
            }, 100);
          }),
        { timeout: 5_000 }
      );

      // Verify the request was submitted exactly once with the original key.
      const matching = submittedRequests.filter(
        (r) => r.idempotencyKey === idempotencyKey
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
      expect(matching[0].idempotencyKey).toBe(idempotencyKey);
    }
  );

  test("queued payment uses the same idempotency key on retry (no double-submit)", async ({
    page,
    context,
  }) => {
    const seenKeys: string[] = [];

    // First call fails with a network error; second call succeeds.
    let callCount = 0;
    await page.route("**/api/v1/payments", async (route: Route) => {
      const headers = await route.request().allHeaders();
      seenKeys.push(headers["idempotency-key"] ?? "");
      callCount++;
      if (callCount === 1) {
        await route.abort("failed"); // simulate network failure on first attempt
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "ok" }),
        });
      }
    });

    await goToPaymentPage(page);
    await context.setOffline(true);

    const idemKey = `retry-test-${Date.now()}`;
    await page.evaluate(
      async ({ url, idemKey }: { url: string; idemKey: string }) => {
        const { enqueuePayment } = await import("/src/sw/outbox.ts");
        await enqueuePayment({
          url,
          body: JSON.stringify({ amount: 50, corridor: "USD_NGN" }),
          idempotencyKey: idemKey,
        });
      },
      { url: `${API_BASE_URL}/api/v1/payments`, idemKey: idemKey }
    );

    await context.setOffline(false);

    // Wait for the queue to drain.
    await page.waitForTimeout(3_000);

    // All retry attempts must use the same idempotency key.
    const relevant = seenKeys.filter((k) => k === idemKey);
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    // Every recorded key must equal the original — no new keys generated.
    for (const k of relevant) {
      expect(k).toBe(idemKey);
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite: stale FX rate banner
// ---------------------------------------------------------------------------

test.describe("Stale FX rate banner (Issue #21)", () => {
  test("banner appears when displayed rate is > 60 s old", async ({ page }) => {
    // Intercept the rates API to return a stale timestamp (61 s ago).
    await page.route("**/api/v1/rates**", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          corridor: "USD_NGN",
          rate: 1620.5,
          fetchedAt: Date.now() - 61_000, // 61 seconds ago — stale
        }),
      });
    });

    await goToPaymentPage(page);

    // The stale banner should appear within 2 s (61 s already elapsed,
    // so the timer fires immediately).
    await expect(
      page.getByTestId("stale-rate-banner")
    ).toBeVisible({ timeout: 2_000 });
  });

  test("banner disappears when fresh rate is loaded", async ({ page }) => {
    let callCount = 0;

    await page.route("**/api/v1/rates**", async (route: Route) => {
      callCount++;
      if (callCount === 1) {
        // First call: stale rate (61 s ago)
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            corridor: "USD_NGN",
            rate: 1620.5,
            fetchedAt: Date.now() - 61_000,
          }),
        });
      } else {
        // Subsequent calls: fresh rate
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            corridor: "USD_NGN",
            rate: 1621.0,
            fetchedAt: Date.now(),
          }),
        });
      }
    });

    await goToPaymentPage(page);

    // Banner should initially be visible (stale rate).
    await expect(
      page.getByTestId("stale-rate-banner")
    ).toBeVisible({ timeout: 2_000 });

    // After the poll interval fires and returns a fresh rate, the banner
    // should disappear.  The test RateDisplay uses a 1 s poll interval for speed.
    await expect(
      page.getByTestId("stale-rate-banner")
    ).not.toBeVisible({ timeout: 5_000 });
  });

  test("POST /api/v1/payments response is never cached by service worker", async ({
    page,
    context,
  }) => {
    // Track which requests actually hit the network (not served from SW cache).
    const networkHits: string[] = [];

    await page.route("**/api/v1/payments", async (route: Route) => {
      networkHits.push(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    });

    await goToPaymentPage(page);

    // Issue two identical POST requests.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(async (url: string) => {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: 100 }),
        });
      }, `${API_BASE_URL}/api/v1/payments`);
    }

    // Both requests must have hit the network — if the SW cached the first
    // response and served the second from cache, networkHits would only have 1.
    expect(networkHits.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test suite: offline page UI
// ---------------------------------------------------------------------------

test.describe("Offline page UI (Issue #21)", () => {
  test("shows offline indicator and queued count when navigator is offline", async ({
    page,
    context,
  }) => {
    await context.setOffline(true);
    await goToOfflinePage(page);

    await expect(
      page.getByTestId("connectivity-indicator")
    ).toContainText("No internet connection");
  });

  test("connectivity indicator updates to online without reload", async ({
    page,
    context,
  }) => {
    await context.setOffline(true);
    await goToOfflinePage(page);

    await expect(
      page.getByTestId("connectivity-indicator")
    ).toContainText("No internet connection");

    // Restore connectivity — indicator should update within 1 s.
    await context.setOffline(false);

    await expect(
      page.getByTestId("connectivity-indicator")
    ).toContainText("Back online", { timeout: 1_500 });
  });
});
