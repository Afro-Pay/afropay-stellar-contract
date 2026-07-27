import request from "supertest";
import jwt from "jsonwebtoken";
import express, { Express } from "express";

import sep31Router from "../../routes/sep31";
import { transactions, customers } from "../../store";

const JWT_SECRET = "test-sep10-jwt-secret-do-not-use-in-production";

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(sep31Router);
  return app;
}

let app: Express;
let validToken: string;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  app = buildTestApp();

  validToken = jwt.sign(
    { sub: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37" },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
});

beforeEach(() => {
  transactions.clear();
  customers.clear();

  customers.set("sender-001", {
    id: "sender-001",
    account: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
    fields: { first_name: "Test", last_name: "Sender", email_address: "sender@test.com" },
  });
  customers.set("receiver-001", {
    id: "receiver-001",
    account: "GBC2R2GJZCL3G2PJK3Q5B6P7K2S4Q5R6T7U8V9W0X1Y2Z3A4B5C6D7E8F9",
    fields: { first_name: "Test", last_name: "Receiver", email_address: "receiver@test.com" },
  });
});

function validPaymentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset_code: "USDC",
    amount: "100",
    sender_id: "sender-001",
    receiver_id: "receiver-001",
    fields: { transaction: { receiver_account_number: "1234567890" } },
    ...overrides,
  };
}

describe("Adversarial: Fee Manipulation", () => {
  it("normal payment without fee fields succeeds with server-computed fee", async () => {
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPaymentBody());

    expect(res.status).toBe(201);

    const tx = transactions.get(res.body.id);
    expect(tx).toBeDefined();
    expect(tx!.amount_fee).toBe("0.50");
  });

  it("payment with feeOverride field is rejected with 400", async () => {
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPaymentBody({ feeOverride: "0.01" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("fee");
  });

  it("payment with fee field is rejected with 400", async () => {
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPaymentBody({ fee: "0.01" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("fee");
  });

  it("payment with amount_fee field is rejected with 400", async () => {
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPaymentBody({ amount_fee: "0.01" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("fee");
  });

  it("server-computed fee matches config (0.50 fixed for USDC)", async () => {
    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${validToken}`)
      .send(validPaymentBody({ amount: "200" }));

    expect(res.status).toBe(201);

    const tx = transactions.get(res.body.id);
    expect(tx).toBeDefined();
    expect(tx!.amount_fee).toBe("0.50");
    expect(tx!.amount_out).toBe("199.50");
  });
});
