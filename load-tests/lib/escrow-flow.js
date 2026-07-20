/**
 * Escrow creation and status polling flow.
 *
 * Simulates a complete escrow lifecycle:
 *  1. POST /api/v1/escrow  → create escrow
 *  2. GET  /api/v1/escrow/:id  → poll state (up to 3 times with back-off)
 *
 * @param {string} baseUrl   - API base URL
 * @param {string} corridor  - Payment corridor e.g. "EUR_GHS"
 */
export function escrowFlow(baseUrl, corridor) {
  const payload = JSON.stringify({
    sender_account: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    corridor: corridor,
    amount_usdc: (Math.random() * 500 + 50).toFixed(2),
  });

  const createRes = http.post(`${baseUrl}/api/v1/escrow`, payload, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    tags: { scenario: "escrow_creation", corridor },
  });

  const created = check(createRes, {
    "escrow created 201": (r) => r.status === 201,
  });

  if (!created) return;

  let escrowId;
  try {
    escrowId = JSON.parse(createRes.body).escrow_id;
  } catch {
    return;
  }

  // Poll up to 3 times with increasing back-off (simulating a UI polling loop)
  for (let attempt = 0; attempt < 3; attempt++) {
    sleep(0.5 * (attempt + 1));

    const pollRes = http.get(`${baseUrl}/api/v1/escrow/${escrowId}`, {
      headers: { Accept: "application/json" },
      tags: { scenario: "escrow_poll", corridor, attempt: String(attempt) },
    });

    const ok = check(pollRes, {
      "escrow poll 200": (r) => r.status === 200,
      "escrow has state": (r) => {
        try {
          return !!JSON.parse(r.body).state;
        } catch {
          return false;
        }
      },
    });

    // Stop polling once we get a terminal state
    if (ok) {
      try {
        const body = JSON.parse(pollRes.body);
        if (["Released", "Refunded", "Refundable", "Cancelled"].includes(body.state)) {
          break;
        }
      } catch {
        // continue
      }
    }
  }
}

// k6 built-ins must be imported at module level in the scenario files;
// re-import here for the shared library.
import http from "k6/http";
import { check, sleep } from "k6";
