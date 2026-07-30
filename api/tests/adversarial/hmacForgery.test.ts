import request from "supertest";
import { createHmac } from "crypto";
import express, { Express } from "express";

import flutterwaveRouter from "../../webhooks/flutterwave";
import paystackRouter from "../../webhooks/paystack";
import { clearRecords } from "../../webhooks/idempotency-store";

const FLW_SECRET = "test-flw-secret-512";
const PS_SECRET = "test-paystack-secret-256";

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/webhooks/flutterwave", flutterwaveRouter);
  app.use("/webhooks/paystack", paystackRouter);
  return app;
}

let app: Express;

beforeAll(() => {
  process.env.FLW_WEBHOOK_SECRET = FLW_SECRET;
  process.env.PAYSTACK_SECRET_KEY = PS_SECRET;
  app = buildTestApp();
});

beforeEach(() => {
  clearRecords();
});

const sampleFlwBody = {
  event: "charge.completed",
  data: { id: 12345, tx_ref: "FLW-ADV-HMAC", status: "successful" },
};

const samplePsBody = {
  event: "charge.success",
  data: { id: 55555, reference: "PS-ADV-HMAC", status: "success" },
};

describe("Adversarial: HMAC Forgery — Flutterwave", () => {
  it("wrong signature value returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/flutterwave")
      .set("verif-hash", "totally-wrong-signature")
      .send(sampleFlwBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("missing verif-hash header returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/flutterwave")
      .send(sampleFlwBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("empty verif-hash header returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/flutterwave")
      .set("verif-hash", "")
      .send(sampleFlwBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("non-hex special characters as signature returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/flutterwave")
      .set("verif-hash", "!@#$%^&*()_+{}[]|\\:;\"'<>,.?/~`")
      .send(sampleFlwBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("valid signature for different body returns 400", async () => {
    const differentBody = {
      event: "charge.completed",
      data: { id: 99999, tx_ref: "FLW-ADV-HMAC", status: "successful" },
    };
    const sigForOriginal = createHmac("sha512", FLW_SECRET)
      .update(JSON.stringify(sampleFlwBody))
      .digest("hex");

    const res = await request(app)
      .post("/webhooks/flutterwave")
      .set("verif-hash", sigForOriginal)
      .send(differentBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });
});

describe("Adversarial: HMAC Forgery — Paystack", () => {
  it("wrong signature value returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/paystack")
      .set("x-paystack-signature", "000000badbadbad")
      .send(samplePsBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("missing x-paystack-signature header returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/paystack")
      .send(samplePsBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("empty signature header returns 400", async () => {
    const res = await request(app)
      .post("/webhooks/paystack")
      .set("x-paystack-signature", "")
      .send(samplePsBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });

  it("very long signature (buffer overflow probe) returns 400", async () => {
    const longSig = "a".repeat(10000);
    const res = await request(app)
      .post("/webhooks/paystack")
      .set("x-paystack-signature", longSig)
      .send(samplePsBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
  });
});
