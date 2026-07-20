"use strict";
/**
 * adminAuth.ts
 *
 * Express middleware that validates an admin JWT in the Authorization header.
 *
 * The token must be signed with ADMIN_JWT_SECRET and carry { role: "admin" }.
 * Returns 401 on missing token and 403 on invalid/expired token or wrong role.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAdmin = requireAdmin;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function requireAdmin(req, res, next) {
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
        res.status(500).json({ error: "ADMIN_JWT_SECRET is not configured" });
        return;
    }
    const header = req.get("Authorization") ?? "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
        res.status(401).json({ error: "Authorization header with Bearer token is required" });
        return;
    }
    try {
        const payload = jsonwebtoken_1.default.verify(match[1], secret);
        if (payload["role"] !== "admin") {
            res.status(403).json({ error: "Token does not carry admin role" });
            return;
        }
        req.adminToken = { sub: String(payload["sub"] ?? ""), role: "admin" };
        next();
    }
    catch {
        res.status(403).json({ error: "Invalid or expired admin JWT" });
    }
}
//# sourceMappingURL=adminAuth.js.map