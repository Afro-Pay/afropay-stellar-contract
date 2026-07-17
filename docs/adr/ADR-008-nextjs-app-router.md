# ADR-008: Next.js App Router for Frontend

**Date:** 2024-03-10  
**Status:** Accepted  
**Deciders:** AfroPay core team

---

## Context and Problem Statement

AfroPay needs a web frontend for the sender dashboard: initiating transfers, tracking escrow status, claiming refunds, and displaying transaction history. The frontend must integrate with Stellar wallets (Freighter, Lobstr), the NestJS API layer, and Horizon's event stream.

The choice of frontend architecture determines SEO capability, performance characteristics, developer experience, and long-term maintenance burden.

---

## Decision Drivers

- **Stellar wallet integration:** Must work with `@stellar/freighter-api` and similar browser extension APIs.
- **SEO:** The marketing landing page and corridor information pages benefit from server-side rendering for discoverability.
- **Performance:** Dashboard pages (authenticated, dynamic) need client-side interactivity without full-page reloads.
- **Developer experience:** The team's existing expertise is in TypeScript/React.
- **Deployment:** Must be deployable to Vercel or a standard Node.js server.
- **API integration:** Must call the NestJS REST API with JWT (issued via SEP-10).

---

## Considered Options

1. **Next.js App Router** — Next.js 14+ with the App Router, React Server Components, and selective client components
2. **React SPA + Express API proxy** — Vite/Create React App SPA served by an Express.js proxy
3. **Remix** — Full-stack React framework with file-based routing and server-side data loading

---

## Decision Outcome

**Chosen option:** Next.js App Router

**Rationale:** Next.js App Router provides the best balance of SSR (for marketing and SEO pages), client-side interactivity (for the wallet-connected dashboard), and deployment simplicity. The team has existing Next.js experience, and the App Router's React Server Components model cleanly separates public/authenticated page concerns.

---

## Pros and Cons of Each Option

### Option 1 — Next.js App Router

**Pros:**
- React Server Components for marketing and static pages — fast first load, good SEO
- Client components for wallet-connected dashboard — `use client` directive is explicit and auditable
- Built-in API routes for lightweight BFF (backend-for-frontend) patterns
- First-class TypeScript support
- Vercel deployment with zero configuration; also self-hostable
- Large ecosystem — Stellar wallet libraries (`@stellar/freighter-api`) work in client components
- `next/image` and `next/font` optimisations reduce Core Web Vitals friction

**Cons:**
- App Router is a significant paradigm shift from Pages Router — learning curve for contributors familiar with older Next.js
- React Server Components and streaming add mental complexity to data fetching patterns
- Client/server boundary errors can be subtle (e.g., importing a server module in a client component)
- Wallet extensions (`window.freighter`) are browser-only — requires careful `use client` annotation

**Reason chosen:** Best overall fit. The client/server boundary complexity is acceptable given the team's React expertise.

---

### Option 2 — React SPA + Express API Proxy

**Pros:**
- Simple mental model — everything runs in the browser
- No server-side rendering to reason about
- Easier Stellar wallet integration (no SSR hydration issues)

**Cons:**
- No SSR for marketing pages — poor SEO without additional tooling
- Initial load performance is worse (full JS bundle before first render)
- Separate Express proxy adds an additional service to operate and maintain
- No built-in code splitting or image optimisation
- Routing is manual or requires React Router configuration

**Reason rejected:** Poor SEO and performance compared to SSR-capable alternatives. Extra operational complexity of a separate proxy service.

---

### Option 3 — Remix

**Pros:**
- Excellent progressive enhancement model
- Nested routing with loader/action data fetching is clean
- Good SSR performance
- Strong TypeScript integration

**Cons:**
- Smaller ecosystem and community than Next.js
- Fewer AfroPay team members have Remix experience
- Stellar wallet libraries have fewer Remix examples in the community
- Deployment options are more limited than Vercel/Next.js

**Reason rejected:** Team familiarity and ecosystem size favour Next.js for long-term maintainability.

---

## Consequences

### Positive

- Marketing pages and corridor landing pages are server-side rendered — full SEO benefit.
- Dashboard and wallet-connected pages use client components with real-time updates via Horizon event streams.
- Vercel deployment pipeline is straightforward with GitHub Actions.
- App Router's `layout.tsx` hierarchy enables consistent authentication wrappers.

### Negative

- Contributors must understand the App Router's client/server boundary model before touching frontend code.
- Stellar wallet APIs (`window.freighter`) are browser-only — all wallet interaction must be in `"use client"` components.
- React Server Components cannot hold wallet state — wallet context must be managed in a client-side provider.

### Neutral

- The frontend repository is separate from this smart contract repository. This ADR is recorded here because the frontend architecture decision affects how the smart contract's events and state are consumed (Horizon polling, WebSocket, or Server-Sent Events).

---

## References

- [Next.js App Router documentation](https://nextjs.org/docs/app)
- [React Server Components](https://react.dev/blog/2023/03/22/react-labs-what-we-have-been-working-on-march-2023)
- [Freighter API](https://docs.freighter.app/)
- [Stellar Wallets Kit](https://stellarwallets.org/)
- [AfroPay Architecture Overview](../../README.md#architecture-overview)
- Related issue: #39
