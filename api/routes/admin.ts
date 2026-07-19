/**
 * api/routes/admin.ts
 *
 * Thin re-export shim — the implementation lives in the reconciliation
 * service (services/reconciliation/adminRouter.ts) which owns the pg and
 * express dependencies.  The api package imports the built JS at runtime;
 * this file satisfies TypeScript module resolution for the api tsconfig.
 */
export {
  buildAdminRouter,
  buildAdminRouterFromEnv,
} from "../../services/reconciliation/adminRouter";
