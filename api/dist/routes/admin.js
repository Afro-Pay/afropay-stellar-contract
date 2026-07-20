"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAdminRouterFromEnv = exports.buildAdminRouter = void 0;
/**
 * api/routes/admin.ts
 *
 * Thin re-export shim — the implementation lives in the reconciliation
 * service (services/reconciliation/adminRouter.ts) which owns the pg and
 * express dependencies.  The api package imports the built JS at runtime;
 * this file satisfies TypeScript module resolution for the api tsconfig.
 */
var adminRouter_1 = require("../../services/reconciliation/adminRouter");
Object.defineProperty(exports, "buildAdminRouter", { enumerable: true, get: function () { return adminRouter_1.buildAdminRouter; } });
Object.defineProperty(exports, "buildAdminRouterFromEnv", { enumerable: true, get: function () { return adminRouter_1.buildAdminRouterFromEnv; } });
//# sourceMappingURL=admin.js.map