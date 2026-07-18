import { Router, Request, Response } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { requireSep10 } from "../middleware/sep10";
import { customers, findCustomer } from "../store";

const router = Router();
router.use(requireSep10);

const formData = multer();

/** Fields AfroPay requires to KYC a SEP-31 sender or receiver. */
export const REQUIRED_CUSTOMER_FIELDS: Record<
  string,
  { type: string; description: string; optional?: boolean }
> = {
  first_name: { type: "string", description: "The customer's first name" },
  last_name: { type: "string", description: "The customer's last name" },
  email_address: { type: "string", description: "The customer's email address" },
};

function missingFields(fields: Record<string, string>): string[] {
  return Object.keys(REQUIRED_CUSTOMER_FIELDS).filter((f) => !fields[f]);
}

function authorizedForAccount(req: Request, account?: string, memo?: string): boolean {
  if (!account) return true;
  if (account !== req.sep10!.account) return false;
  if (req.sep10!.memo && memo && req.sep10!.memo !== memo) return false;
  return true;
}

/** SEP-12 GET /customer — customer status lookup. */
router.get("/customer", (req: Request, res: Response) => {
  const id = req.query.id as string | undefined;
  const account = (req.query.account as string | undefined) || req.sep10!.account;
  const memo = (req.query.memo as string | undefined) || req.sep10!.memo;

  if (!authorizedForAccount(req, req.query.account as string | undefined, memo)) {
    return void res
      .status(403)
      .json({ error: "account does not match the authenticated account" });
  }

  const customer = findCustomer({ id, account, memo });
  if (id && !customer) {
    return void res.status(404).json({ error: `customer not found for id ${id}` });
  }

  if (!customer) {
    return void res.status(200).json({
      status: "NEEDS_INFO",
      fields: REQUIRED_CUSTOMER_FIELDS,
    });
  }

  const missing = missingFields(customer.fields);
  if (missing.length > 0) {
    const fields: typeof REQUIRED_CUSTOMER_FIELDS = {};
    for (const f of missing) fields[f] = REQUIRED_CUSTOMER_FIELDS[f];
    return void res.status(200).json({ id: customer.id, status: "NEEDS_INFO", fields });
  }

  const provided: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(customer.fields)) {
    provided[name] = {
      ...(REQUIRED_CUSTOMER_FIELDS[name] ?? { type: "string", description: name }),
      status: "ACCEPTED",
    };
    void value;
  }
  res.status(200).json({ id: customer.id, status: "ACCEPTED", provided_fields: provided });
});

/** SEP-12 PUT /customer — create or update a customer. */
router.put("/customer", formData.none(), (req: Request, res: Response) => {
  const body: Record<string, string> = { ...(req.body || {}) };
  const id = body.id;
  const account = body.account || req.sep10!.account;
  const memo = body.memo || req.sep10!.memo;
  const type = body.type;
  delete body.id;
  delete body.account;
  delete body.memo;
  delete body.memo_type;
  delete body.type;

  if (!authorizedForAccount(req, req.body?.account, memo)) {
    return void res
      .status(403)
      .json({ error: "account does not match the authenticated account" });
  }

  let customer = findCustomer({ id, account, memo });
  if (id && !customer) {
    return void res.status(404).json({ error: `customer not found for id ${id}` });
  }

  const unknown = Object.keys(body).filter(
    (f) => !(f in REQUIRED_CUSTOMER_FIELDS)
  );
  if (unknown.length > 0) {
    return void res
      .status(400)
      .json({ error: `unsupported SEP-9 fields: ${unknown.join(", ")}` });
  }

  if (!customer) {
    customer = { id: uuidv4(), account, memo, type, fields: {} };
    customers.set(customer.id, customer);
  }
  Object.assign(customer.fields, body);

  res.status(202).json({ id: customer.id });
});

/** SEP-12 DELETE /customer/:account — delete all customer data for an account. */
router.delete("/customer/:account", (req: Request, res: Response) => {
  const account = req.params.account;
  if (account !== req.sep10!.account) {
    return void res
      .status(403)
      .json({ error: "account does not match the authenticated account" });
  }
  const memo = (req.body?.memo as string | undefined) || req.sep10!.memo;
  let deleted = false;
  for (const [id, customer] of customers) {
    if (customer.account === account && (customer.memo ?? undefined) === memo) {
      customers.delete(id);
      deleted = true;
    }
  }
  if (!deleted) {
    return void res.status(404).json({ error: "customer not found" });
  }
  res.status(200).json({});
});

export default router;
