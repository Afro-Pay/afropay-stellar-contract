"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.REQUIRED_CUSTOMER_FIELDS = void 0;
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const uuid_1 = require("uuid");
const sep10_1 = require("../middleware/sep10");
const store_1 = require("../store");
const router = (0, express_1.Router)();
router.use(sep10_1.requireSep10);
const formData = (0, multer_1.default)();
/** Fields AfroPay requires to KYC a SEP-31 sender or receiver. */
exports.REQUIRED_CUSTOMER_FIELDS = {
    first_name: { type: "string", description: "The customer's first name" },
    last_name: { type: "string", description: "The customer's last name" },
    email_address: { type: "string", description: "The customer's email address" },
};
function missingFields(fields) {
    return Object.keys(exports.REQUIRED_CUSTOMER_FIELDS).filter((f) => !fields[f]);
}
function authorizedForAccount(req, account, memo) {
    if (!account)
        return true;
    if (account !== req.sep10.account)
        return false;
    if (req.sep10.memo && memo && req.sep10.memo !== memo)
        return false;
    return true;
}
/** SEP-12 GET /customer — customer status lookup. */
router.get("/customer", (req, res) => {
    const id = req.query.id;
    const account = req.query.account || req.sep10.account;
    const memo = req.query.memo || req.sep10.memo;
    if (!authorizedForAccount(req, req.query.account, memo)) {
        return void res
            .status(403)
            .json({ error: "account does not match the authenticated account" });
    }
    const customer = (0, store_1.findCustomer)({ id, account, memo });
    if (id && !customer) {
        return void res.status(404).json({ error: `customer not found for id ${id}` });
    }
    if (!customer) {
        return void res.status(200).json({
            status: "NEEDS_INFO",
            fields: exports.REQUIRED_CUSTOMER_FIELDS,
        });
    }
    const missing = missingFields(customer.fields);
    if (missing.length > 0) {
        const fields = {};
        for (const f of missing)
            fields[f] = exports.REQUIRED_CUSTOMER_FIELDS[f];
        return void res.status(200).json({ id: customer.id, status: "NEEDS_INFO", fields });
    }
    const provided = {};
    for (const [name, value] of Object.entries(customer.fields)) {
        provided[name] = {
            ...(exports.REQUIRED_CUSTOMER_FIELDS[name] ?? { type: "string", description: name }),
            status: "ACCEPTED",
        };
        void value;
    }
    res.status(200).json({ id: customer.id, status: "ACCEPTED", provided_fields: provided });
});
/** SEP-12 PUT /customer — create or update a customer. */
router.put("/customer", formData.none(), (req, res) => {
    const body = { ...(req.body || {}) };
    const id = body.id;
    const account = body.account || req.sep10.account;
    const memo = body.memo || req.sep10.memo;
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
    let customer = (0, store_1.findCustomer)({ id, account, memo });
    if (id && !customer) {
        return void res.status(404).json({ error: `customer not found for id ${id}` });
    }
    const unknown = Object.keys(body).filter((f) => !(f in exports.REQUIRED_CUSTOMER_FIELDS));
    if (unknown.length > 0) {
        return void res
            .status(400)
            .json({ error: `unsupported SEP-9 fields: ${unknown.join(", ")}` });
    }
    if (!customer) {
        customer = { id: (0, uuid_1.v4)(), account, memo, type, fields: {} };
        store_1.customers.set(customer.id, customer);
    }
    Object.assign(customer.fields, body);
    res.status(202).json({ id: customer.id });
});
/** SEP-12 DELETE /customer/:account — delete all customer data for an account. */
router.delete("/customer/:account", (req, res) => {
    const account = req.params.account;
    if (account !== req.sep10.account) {
        return void res
            .status(403)
            .json({ error: "account does not match the authenticated account" });
    }
    const memo = req.body?.memo || req.sep10.memo;
    let deleted = false;
    for (const [id, customer] of store_1.customers) {
        if (customer.account === account && (customer.memo ?? undefined) === memo) {
            store_1.customers.delete(id);
            deleted = true;
        }
    }
    if (!deleted) {
        return void res.status(404).json({ error: "customer not found" });
    }
    res.status(200).json({});
});
exports.default = router;
//# sourceMappingURL=sep12.js.map