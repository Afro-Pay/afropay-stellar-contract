import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";

export interface Sep10Token {
  /** Full `sub` claim: G..., G...:memo, or M... */
  sub: string;
  account: string;
  memo?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    sep10?: Sep10Token;
  }
}

/**
 * SEP-10 JWT bearer authentication. Protected SEP endpoints (SEP-12, SEP-31)
 * must respond 403 to requests without a valid token.
 */
export function requireSep10(req: Request, res: Response, next: NextFunction): void {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    res.status(403).json({ error: "missing SEP-10 JWT in Authorization header" });
    return;
  }
  try {
    const payload = jwt.verify(match[1], config.jwtSecret) as jwt.JwtPayload;
    const sub = String(payload.sub);
    const [account, memo] = sub.split(":");
    req.sep10 = { sub, account, memo };
    next();
  } catch {
    res.status(403).json({ error: "invalid or expired SEP-10 JWT" });
  }
}
