# AfroPay — Deployment Pipeline

> **Audience:** Developers, DevOps engineers, and on-call engineers.
> This document describes the end-to-end CI/CD pipeline, deployment strategies, rollback procedures, and operational expectations for the AfroPay platform.

---

## Table of Contents

1. [Pipeline Overview](#1-pipeline-overview)
2. [Workflow Reference](#2-workflow-reference)
3. [CI — Continuous Integration (`ci.yml`)](#3-ci--continuous-integration)
4. [Staging Deployment (`deploy-staging.yml`)](#4-staging-deployment)
5. [Production Deployment (`deploy-prod.yml`)](#5-production-deployment)
6. [Rollback Procedures](#6-rollback-procedures)
7. [CODEOWNERS & Review Gates](#7-codeowners--review-gates)
8. [Required Secrets & Variables](#8-required-secrets--variables)
9. [Smoke Test Reference](#9-smoke-test-reference)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Pipeline Overview

```
Pull Request opened / push to main
         │
         ▼
┌────────────────────────────────────────────┐
│           CI  (ci.yml)                     │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │  Rust    │ │  Node    │ │  Frontend  │ │  ← parallel jobs
│  │contracts │ │   API    │ │  Vitest /  │ │
│  │ test/fmt │ │ jest/tsc │ │ vite build │ │
│  └──────────┘ └──────────┘ └────────────┘ │
│        All must pass to allow merge        │
└────────────────┬───────────────────────────┘
                 │ merge to main
                 ▼
┌────────────────────────────────────────────┐
│     Staging Deploy (deploy-staging.yml)    │
│  1. Build & push Docker images to GHCR    │
│  2. kubectl rolling update on staging     │
│  3. Health check /health (2 min timeout)  │
│  4. k6 smoke test (5 VU / 1 min)         │
│     PASS → tag images :staging-stable     │
│     FAIL → kubectl rollout undo (auto)    │
└────────────────┬───────────────────────────┘
                 │ manual workflow_dispatch
                 │ (with explicit image tag)
                 ▼
┌────────────────────────────────────────────┐
│     Prod Deploy (deploy-prod.yml)          │
│  1. GitHub Environment "production" gate  │
│     → production-approvers team approves  │
│  2. Blue-green deployment strategy:       │
│     a. Start GREEN pods (new image)       │
│     b. Wait for pods ready                │
│     c. Switch service selector → green   │
│     d. Health check /health (2 min)       │
│     e. k6 smoke test (5 VU / 1 min)      │
│     PASS → promote green→blue, rm green  │
│     FAIL → revert selector→blue, rm green│
└────────────────────────────────────────────┘
```

---

## 2. Workflow Reference

| Workflow file | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Every PR, push to `main`/`develop` | Build, test, lint all components |
| `deploy-staging.yml` | Push to `main`, manual dispatch | Build images, deploy staging, smoke gate |
| `deploy-prod.yml` | Manual dispatch only | Blue-green deploy to production |
| `security-scan.yml` | Schedule + PR | SAST, dependency audit, secret scanning |
| `load-tests.yml` | Manual / schedule | Full k6 load + stress test suite |
| `dr-drill.yml` | Schedule (monthly) | Disaster recovery drill |
| `aml-tests.yml` | PR on `services/aml/**` | AML rule engine Rust tests |
| `escrow-tests.yml` | PR on `contracts/**`, `src/**` | Soroban escrow contract tests |
| `sep-compliance.yml` | PR on `api/**` | SEP-10/12/31 compliance checks |

---

## 3. CI — Continuous Integration

**File:** `.github/workflows/ci.yml`
**Triggers:** Pull requests and pushes targeting `main` or `develop`
**Concurrency:** One run per branch; newer commits cancel previous in-flight runs.

### Jobs (run in parallel)

#### `rust-contracts`

| Step | Details |
|---|---|
| Rust toolchain | Pinned to `1.81` (matches soroban-sdk 20.x) |
| Build target | `wasm32-unknown-unknown --release` |
| Test | `cargo test --workspace --features testutils` |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Format | `cargo fmt --all -- --check` |
| Arithmetic audit | `scripts/check-unchecked-arithmetic.sh` |
| Vuln scan | `cargo audit` |

#### `api`

| Step | Details |
|---|---|
| Node.js | `22.x` |
| Install | `npm ci` (lockfile-based) |
| Type-check | `tsc --noEmit` |
| Lint | ESLint with `--max-warnings 0` |
| Test | `npm run test:ci` (Jest, `--runInBand --forceExit`) |

Environment variables injected for tests: stub Stellar seed, dummy JWT secret, empty DATABASE_URL/REDIS_URL (unit tests mock all I/O).

#### `frontend`

| Step | Details |
|---|---|
| Node.js | `22.x` |
| Install | `npm ci` |
| Type-check | `tsc --noEmit` |
| Lint | ESLint with `--max-warnings 0` |
| Test | `npm test` (Vitest) |
| Build | `npm run build` (Vite production bundle) |

Build artifacts are uploaded as `frontend-dist` with 7-day retention.

### Merge gate

Branch protection on `main` and `develop` must require all three CI jobs to pass before merge is allowed. Configure this under:

**Settings → Branches → Add rule → Require status checks → select `Rust Contracts`, `Node API`, `Frontend`**

---

## 4. Staging Deployment

**File:** `.github/workflows/deploy-staging.yml`
**Triggers:** Push to `main` (automatically after merge), or manual `workflow_dispatch`.
**Concurrency:** Serialised — a new staging deploy will wait for any in-flight deploy to finish (never cancelled).

### Flow

```
build-and-push ──► deploy-staging ──► smoke-test
                        │                  │
                    health check        k6 smoke
                    fails? ──► rollout undo
                                        │
                                 fails? ──► rollout undo
                                        │
                                 passes? ──► tag :staging-stable
```

### Step details

**1. Build & push (`build-and-push` job)**

- Builds `Dockerfile.api` → `ghcr.io/<owner>/afropay-api:<sha>`
- Builds `Dockerfile.frontend` → `ghcr.io/<owner>/afropay-frontend:<sha>`
- Both images are also tagged `:staging-latest`
- Layer caching is stored in GHCR (`type=registry` buildx cache)
- OCI labels (`source`, `revision`, `created`) are applied

**2. Deploy (`deploy-staging` job)**

- Decodes `KUBECONFIG_STAGING` secret and writes `~/.kube/config`
- Records the current deployment revision (rollback anchor)
- Calls `kubectl set image` for both deployments
- Waits for `kubectl rollout status --timeout=300s`
- Polls `/health` for up to 2 minutes (24 × 5 s attempts)
- On failure: calls `kubectl rollout undo` on both deployments

**3. Smoke test (`smoke-test` job)**

- Installs k6 from the official APT repository
- Runs `load-tests/scenarios/smoke.js` with `BASE_URL=$STAGING_API_URL`
- Profile: 5 VUs, 1 minute duration
- Gates: `p95 < 500ms`, `error rate == 0`
- Results uploaded as `k6-smoke-staging-<sha>` (14-day retention)
- On failure: calls `kubectl rollout undo` on both deployments
- On success: retagged as `:staging-stable`

---

## 5. Production Deployment

**File:** `.github/workflows/deploy-prod.yml`
**Triggers:** `workflow_dispatch` only (never automatic).
**Concurrency:** Serialised — only one production deploy runs at a time.

### Inputs

| Input | Required | Description |
|---|---|---|
| `image_tag` | Yes | Tag from GHCR to promote (e.g. the SHA from a staging-stable run) |
| `reason` | Yes | Change description (logged to audit trail) |
| `skip_smoke` | No | `true` only for emergency hotfixes; requires a second approval |

### Approval gate

The workflow is gated on the `production` GitHub Environment. This environment must be configured with:

- **Required reviewers:** `@afropay/production-approvers`
- **Prevent self-review:** enabled
- **Wait timer:** optional (e.g. 30 minutes minimum notice)

No code executes until a member of `production-approvers` approves the pending deployment via the GitHub Actions UI or API.

### Blue-green strategy

```
BEFORE CUT-OVER
  Service selector → slot: blue
  afropay-api         (blue, current image)
  afropay-api-green   (not yet started)

AFTER GREEN PODS READY
  afropay-api         (blue, old image)   ← still receiving traffic
  afropay-api-green   (green, new image)  ← standing by

CUT-OVER
  kubectl patch service → selector: slot: green
  → all new requests go to green pods

SMOKE TEST PASSES
  kubectl set image afropay-api (update blue to new image)
  kubectl patch service → selector: slot: blue
  kubectl delete deployment afropay-api-green
  Tag images as :prod-stable

SMOKE TEST FAILS (within 2 min)
  kubectl patch service → selector: slot: blue   ← instant revert
  kubectl delete deployment afropay-api-green
  Job exits non-zero → GitHub marks deploy as failed
```

**Zero-downtime guarantee:** Traffic is never dropped. During the window between selector swap and smoke test completion, both deployments are active. If the smoke test fails, the service selector reverts within 2 minutes (24 × 5 s polling loop).

### Rollback SLO

Automated rollback completes within **2 minutes** of a failed health check or smoke test threshold breach. This is enforced by:

1. Health check: 24 attempts × 5 s = 2 min maximum before rollback triggers
2. Smoke test duration: 1 min, plus k6 startup overhead < 30 s

Total rollback window ≤ 3.5 minutes (worst case: smoke test starts, runs 1 minute, k6 reports breach, selector reverted).

---

## 6. Rollback Procedures

### Automatic rollback (staging)

Triggered automatically on:
- `/health` not returning 200 within 2 minutes post-deploy
- k6 smoke test threshold breach (`p95 ≥ 500ms` or `error_rate > 0`)

Action: `kubectl rollout undo deployment/afropay-api -n <namespace>`

### Automatic rollback (production)

Triggered automatically on:
- `/health` not returning 200 within 2 minutes post-cut-over
- k6 smoke test threshold breach

Action: Revert service selector to `slot: blue` and delete green deployment.

### Manual rollback (staging)

```bash
# Roll back to the previous revision
kubectl rollout undo deployment/afropay-api -n afropay-staging
kubectl rollout undo deployment/afropay-frontend -n afropay-staging

# Verify
kubectl rollout status deployment/afropay-api -n afropay-staging
```

### Manual rollback (production)

```bash
# Option 1: Revert service selector (if green still exists)
kubectl patch service afropay-api -n afropay-production \
  --type=merge -p '{"spec":{"selector":{"slot":"blue"}}}'
kubectl patch service afropay-frontend -n afropay-production \
  --type=merge -p '{"spec":{"selector":{"slot":"blue"}}}'

# Option 2: Roll back the blue deployment to a previous image
kubectl rollout undo deployment/afropay-api -n afropay-production
kubectl rollout undo deployment/afropay-frontend -n afropay-production

# Option 3: Pin to a specific prod-stable image
kubectl set image deployment/afropay-api \
  api=ghcr.io/<owner>/afropay-api:prod-stable \
  -n afropay-production
```

### Roll back to a specific image tag

```bash
kubectl set image deployment/afropay-api \
  api=ghcr.io/<owner>/afropay-api:<TAG> \
  -n afropay-production
kubectl rollout status deployment/afropay-api -n afropay-production
```

### View rollout history

```bash
kubectl rollout history deployment/afropay-api -n afropay-production
# Show details of a specific revision
kubectl rollout history deployment/afropay-api \
  -n afropay-production --revision=3
```

---

## 7. CODEOWNERS & Review Gates

**File:** `.github/CODEOWNERS`

| Path pattern | Required reviewers |
|---|---|
| `*` | `@afropay/core-team` (default) |
| `contracts/**`, `src/contract.rs` etc. | `@afropay/contracts-team` |
| `db/migrations/**`, `api/migrations/**` | `@afropay/dba-team` + `@afropay/backend-leads` |
| `.github/workflows/**`, `.github/CODEOWNERS` | `@afropay/devops-team` + `@afropay/core-team` |
| `api/services/crypto.ts`, SEP-10 middleware | `@afropay/security-team` + `@afropay/backend-leads` |
| `infrastructure/vault/**` | `@afropay/security-team` + `@afropay/devops-team` |
| `load-tests/**` | `@afropay/devops-team` + `@afropay/core-team` |

**Enforcement:** Enable "Require review from Code Owners" on branch protection for `main` and `develop`.

---

## 8. Required Secrets & Variables

### Repository Secrets (Settings → Secrets → Actions)

| Secret | Description |
|---|---|
| `KUBECONFIG_STAGING` | Base64-encoded kubeconfig for the staging cluster |
| `KUBECONFIG_PROD` | Base64-encoded kubeconfig for the production cluster |

`GITHUB_TOKEN` is automatically provided by GitHub Actions and used for GHCR authentication.

### Repository Variables (Settings → Variables → Actions)

| Variable | Default | Description |
|---|---|---|
| `STAGING_API_URL` | — | Base URL of staging API, e.g. `https://api.staging.afropay.io` |
| `PROD_API_URL` | — | Base URL of production API, e.g. `https://api.afropay.io` |
| `KUBE_NAMESPACE` | `afropay-staging` | Kubernetes namespace for staging |
| `KUBE_NAMESPACE_PROD` | `afropay-production` | Kubernetes namespace for production |

### Generating the base64 kubeconfig

```bash
# Replace with your actual kubeconfig file
cat ~/.kube/config-staging | base64 -w 0
```

Paste the output as the value of `KUBECONFIG_STAGING`.

---

## 9. Smoke Test Reference

**File:** `load-tests/scenarios/smoke.js`

| Parameter | Value | Description |
|---|---|---|
| VUs | 5 | Concurrent virtual users |
| Duration | 1 minute | Test length |
| `http_req_duration` | `p(95) < 500ms` | 95th percentile response time gate |
| `http_req_failed` | `rate == 0` | Zero error rate gate |
| `stellar_submission_latency_ms` | `p(95) < 500ms` | Stellar-specific latency gate |
| `horizon_error_rate` | `rate == 0` | No Horizon errors allowed |

**Scenarios exercised (round-robin):**

1. `paymentFlow` — full payment initiation flow
2. `escrowFlow` — escrow deposit / status check
3. `ratesFetch` — FX rate fetching

**Run manually against staging:**

```bash
k6 run \
  --env BASE_URL=https://api.staging.afropay.io \
  load-tests/scenarios/smoke.js
```

**Run manually against a local dev stack:**

```bash
k6 run \
  --env BASE_URL=http://localhost:8000 \
  load-tests/scenarios/smoke.js
```

---

## 10. Troubleshooting

### CI: Rust `cargo test` fails

```
error[E0433]: failed to resolve: use of undeclared crate or module `testutils`
```

Ensure the test command includes `--features testutils`. The CI workflow passes this flag for the workspace test run.

### CI: `cargo fmt -- --check` fails

Run `cargo fmt --all` locally and commit the result. The CI check is strict — all files must be formatted.

### Staging: Smoke test fails intermittently

Check if the staging cluster is undersized. The smoke test runs 5 concurrent VUs — ensure the API deployment has at least 2 replicas with sufficient CPU.

### Staging: Health check fails after deploy

```bash
# Inspect recent pod events
kubectl describe pod -l app=afropay-api -n afropay-staging | tail -40

# Tail logs of the new pod
kubectl logs -l app=afropay-api -n afropay-staging --since=5m
```

### Production: Deployment stuck waiting for approval

Approve via GitHub UI: **Actions → deploy-prod run → Review deployments → Approve**

Or via CLI:

```bash
gh run approve <run-id>
```

### Production: Green pods fail to start

```bash
# Check green deployment events
kubectl describe deployment afropay-api-green -n afropay-production

# Check pod crash logs
kubectl logs -l slot=green -n afropay-production --previous
```

If the green pods cannot start, the service selector was never switched, so production is unaffected. Delete the green deployment and investigate:

```bash
kubectl delete deployment afropay-api-green -n afropay-production
kubectl delete deployment afropay-frontend-green -n afropay-production
```

### k6 not found / install fails

The k6 install step uses the official GPG-signed APT repository. If the keyserver is unreachable, the install will fail. As a fallback, you can use the k6 Docker image:

```bash
docker run --rm -i grafana/k6:latest run \
  --env BASE_URL=<URL> - < load-tests/scenarios/smoke.js
```

---

*Last updated: 2026-07-24 — Initial pipeline implementation (closes [#31](https://github.com/afropay/afropay-stellar-contract/issues/31))*
