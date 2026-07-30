import { Request, Response, NextFunction, RequestHandler } from "express";

const store = new Map<string, boolean>();

function hashKey(method: string, originalUrl: string, key: string): string {
  return `${method}:${originalUrl}:${key}`;
}

export function clearIdempotencyStore(): void {
  store.clear();
}

export function idempotencyMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "POST" && req.method !== "PATCH" && req.method !== "PUT") {
      next();
      return;
    }

    const key = req.get("Idempotency-Key");
    if (!key || typeof key !== "string" || key.length === 0) {
      next();
      return;
    }

    const k = hashKey(req.method, req.originalUrl, key);
    if (store.has(k)) {
      res.status(409).json({ error: "idempotency_key_already_used", message: "This Idempotency-Key has already been processed" });
      return;
    }

    store.set(k, true);

    next();
  };
}
