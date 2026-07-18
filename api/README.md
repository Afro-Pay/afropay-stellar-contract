# AfroPay Anchor API

SEP-compliant anchor endpoints for AfroPay's on/off-ramp flows:

- **SEP-1** — serves [`public/.well-known/stellar.toml`](../public/.well-known/stellar.toml) with `Content-Type: text/plain` and CORS.
- **SEP-10** — web authentication (`GET`/`POST` at `WEB_AUTH_ENDPOINT`), `routes/sep10.ts` + `middleware/sep10.ts`.
- **SEP-12** — minimal KYC customer registration (dependency of SEP-31), `routes/sep12.ts`.
- **SEP-31** — cross-border payments (`/info`, `/transactions`), `routes/sep31.ts`.

All endpoint locations (web auth, KYC, direct payment server, and their Express
mount paths) are resolved dynamically from `stellar.toml` by `config.ts` —
nothing is hardcoded. See [`docs/compliance/sep-audit.md`](../docs/compliance/sep-audit.md)
for the full compliance audit.

## Run

```bash
npm ci
npm run build
HOME_DOMAIN=localhost:8000 \
SEP10_SIGNING_SEED=<seed matching stellar.toml SIGNING_KEY> \
JWT_SECRET=<random secret> \
npm start
```

### Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `SEP10_SIGNING_SEED` | yes | Secret seed for the anchor's SEP-10 signing key. Without `HOME_DOMAIN`, must match the `SIGNING_KEY` published in stellar.toml. |
| `HOME_DOMAIN` | local/CI | `host[:port]` override. Rewrites the served stellar.toml's endpoint origins and `SIGNING_KEY` to match the running instance (used by CI). |
| `JWT_SECRET` | recommended | HMAC secret for SEP-10 JWTs. Random per-boot if unset. |
| `PORT` | no | Listen port (default 8000). |
| `NETWORK_PASSPHRASE` | no | Overrides the TOML value (defaults to the published one). |
| `HORIZON_URL` | no | Horizon instance for SEP-10 account/threshold lookups. |
| `STELLAR_TOML_PATH` | no | Alternate stellar.toml location. |

## Conformance

CI (`.github/workflows/sep-compliance.yml`) validates stellar.toml and runs the
official `@stellar/anchor-tests` suites for SEP 1, 10, 12, and 31 against a
local instance of this server; merges are blocked on failure.
