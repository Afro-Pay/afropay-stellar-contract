/**
 * Standalone harness page: mounts EscrowTimeline for the escrow id given in
 * the `?escrowId=` query string, against the API origin in `?apiBaseUrl=`
 * (defaults to same-origin). Exists so Playwright has a real page to drive
 * for e2e coverage of the SSE timeline (Issue #24).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EscrowTimeline } from "../components/escrow/EscrowTimeline";

const params = new URLSearchParams(window.location.search);
const escrowId = params.get("escrowId");
const apiBaseUrl = params.get("apiBaseUrl") ?? undefined;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    {escrowId ? (
      <EscrowTimeline escrowId={escrowId} baseUrl={apiBaseUrl} />
    ) : (
      <p>Provide an escrowId query param to view its timeline.</p>
    )}
  </StrictMode>
);
