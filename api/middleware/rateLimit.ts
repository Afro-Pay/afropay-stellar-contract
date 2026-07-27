import { Request, Response, NextFunction, RequestHandler } from "express";

interface SlidingWindowEntry {
  timestamps: number[];
}

function createStore(): Map<string, SlidingWindowEntry> {
  return new Map();
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export function rateLimit(options: RateLimitOptions): RequestHandler & { clearStore: () => void } {
  const { windowMs, maxRequests } = options;
  const store = createStore();

  const handler = (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();

    let entry = store.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      store.set(ip, entry);
    }

    const cutoff = now - windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    entry.timestamps.push(now);

    if (entry.timestamps.length > maxRequests) {
      const oldest = entry.timestamps[0];
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      res.status(429).set("Retry-After", String(retryAfter)).json({
        error: "rate_limit_exceeded",
        message: "Too many requests. Please wait before retrying.",
        retryAfterSeconds: retryAfter,
      });
      return;
    }

    next();
  };

  handler.clearStore = () => store.clear();

  return handler as RequestHandler & { clearStore: () => void };
}
