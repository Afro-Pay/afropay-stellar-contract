/**
 * Payment initiation flow — POST /api/v1/payments
 *
 * Simulates a sender initiating a cross-border payment:
 *  1. POST /api/v1/escrow  → create escrow (payment initiation)
 *  2. Record Stellar submission latency from the X-Stellar-Latency-Ms response header
 *     (or fall back to measuring total request duration).
 *  3. GET  /api/v1/escrow/:id → verify the escrow is in "Funded" state.
 *
 * @param {string}  baseUrl                   - API base URL
 * @param {string}  corridor                  - Payment corridor e.g. "USD_NGN"
 * @param {Trend}   stellarLatencyMetric       - k6 Trend for Stellar submission ms
 * @param {Rate}    horizonErrorRateMetric     - k6 Rate for Horizon failures
 * @returns {object|null}  The HTTP response from the escrow creation, or null on error
 */
export function paymentFlow(baseUrl, corridor, stellarLatencyMetric, horizonErrorRateMetric) {
  const senderAccount = randomStellarAccount();
  const payload = JSON.stringify({
    sender_account: senderAccount,
    corridor: corridor,
    amount_usdc: (Math.random() * 990 + 10).toFixed(2), // $10–$1000
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    tags: { scenario: "payment_initiation", corridor },
  };

  const createRes = http.post(`${baseUrl}/api/v1/escrow`, payload, params);

  // Record custom Stellar submission latency
  if (stellarLatencyMetric) {
    // Prefer the header set by the API if available; fall back to total round-trip
    const headerLatency = createRes.headers["X-Stellar-Latency-Ms"];
    const latencyMs = headerLatency
      ? parseFloat(headerLatency)
      : createRes.timings.duration;
    stellarLatencyMetric.add(latencyMs, { corridor });
  }

  // Track Horizon errors (any 5xx from the escrow endpoint)
  if (horizonErrorRateMetric) {
    horizonErrorRateMetric.add(createRes.status >= 500, { corridor });
  }

  const created = check(createRes, {
    "payment initiation status 201": (r) => r.status === 201,
    "payment initiation has escrow_id": (r) => {
      try {
        return !!JSON.parse(r.body).escrow_id;
      } catch {
        return false;
      }
    },
  });

  if (!created) {
    return createRes;
  }

  // Poll the escrow state
  let escrowId;
  try {
    escrowId = JSON.parse(createRes.body).escrow_id;
  } catch {
    return createRes;
  }

  const pollRes = http.get(`${baseUrl}/api/v1/escrow/${escrowId}`, {
    headers: { Accept: "application/json" },
    tags: { scenario: "escrow_state_poll", corridor },
  });

  check(pollRes, {
    "escrow poll status 200": (r) => r.status === 200,
    "escrow state is Funded": (r) => {
      try {
        return JSON.parse(r.body).state === "Funded";
      } catch {
        return false;
      }
    },
  });

  return createRes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a plausible-looking Stellar G… public key for load test data. */
function randomStellarAccount() {
  // Real test account — safe to reuse in load tests against non-prod environments
  const accounts = [
    "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    "GAHJJJKMOKYE4RVPZEWZTKH5FVI4PA3VL7GK2LFNUBSGBV3BQNQ43EJE",
    "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGWKX2ZVLK79BXTS3ABK1WN",
    "GCB3MZDQHWZGWSTLSAPQIJM52FQBHQGKQY7ENNLIBF5JNT7K3QH5WF2J",
    "GDYMJDW72BXOYJKX75Q5NQSB4QNJRJ57TPLXKJBKCHXGRQHF45DSDQGZ",
  ];
  return accounts[Math.floor(Math.random() * accounts.length)];
}
