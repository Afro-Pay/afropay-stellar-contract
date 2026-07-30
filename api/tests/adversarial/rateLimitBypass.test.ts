import request from "supertest";
import express, { Express } from "express";
import { rateLimit } from "../../middleware/rateLimit";

function buildTestApp(maxRequests = 5, windowMs = 1000): Express {
  const app = express();
  app.use(rateLimit({ windowMs, maxRequests }));

  app.get("/test", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

let app: Express;

beforeEach(() => {
  app = buildTestApp(5, 1000);
});

describe("Adversarial: Rate-Limit Bypass via Header Spoofing", () => {
  it("allows up to maxRequests from the same IP", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    }
  });

  it("blocks the 6th request from the same IP with 429", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get("/test");
    }

    const res = await request(app).get("/test");
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_exceeded");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("spoofed X-Forwarded-For does not bypass the rate limit", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get("/test");
    }

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "1.2.3.4");

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_exceeded");
  });

  it("spoofed X-Forwarded-For with different socket IP is treated as new client", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "1.2.3.4");
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "1.2.3.4");

    expect(blocked.status).toBe(429);
  });

  it("multiple spoofed X-Forwarded-For values are all ignored", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).get("/test");
    }

    const res = await request(app)
      .get("/test")
      .set("X-Forwarded-For", "10.0.0.1, 10.0.0.2, 10.0.0.3");

    expect(res.status).toBe(429);
  });
});
