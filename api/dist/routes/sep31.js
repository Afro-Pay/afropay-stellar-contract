"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const crypto_1 = require("crypto");
const uuid_1 = require("uuid");
const sep10_1 = require("../middleware/sep10");
const config_1 = require("../config");
const store_1 = require("../store");
const router = (0, express_1.Router)();
/** Per-transaction fields AfroPay needs to deliver an off-chain payment. */
const TRANSACTION_FIELDS = {
    receiver_account_number: {
        description: "Bank account or mobile-money number of the receiving customer",
    },
    receiver_routing_number: {
        description: "Routing number of the receiving bank, if applicable",
        optional: true,
    },
};
const ASSETS = {
    USDC: {
        enabled: true,
        min_amount: 1,
        max_amount: 1_000_000,
        fee_fixed: 0.5,
        fee_percent: 0,
    },
};
function badRequest(res, body) {
    res.status(400).json(body);
}
function customerAccepted(id) {
    if (!id)
        return false;
    const customer = store_1.customers.get(id);
    if (!customer)
        return false;
    return ["first_name", "last_name", "email_address"].every((f) => customer.fields[f]);
}
function publicTransaction(t) {
    return {
        id: t.id,
        status: t.status,
        status_eta: t.status_eta,
        status_message: t.status_message,
        amount_in: t.amount_in,
        amount_in_asset: t.amount_in_asset,
        amount_out: t.amount_out,
        amount_out_asset: t.amount_out_asset,
        amount_fee: t.amount_fee,
        amount_fee_asset: t.amount_fee_asset,
        stellar_account_id: t.stellar_account_id,
        stellar_memo_type: t.stellar_memo_type,
        stellar_memo: t.stellar_memo,
        started_at: t.started_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at,
        stellar_transaction_id: t.stellar_transaction_id,
        external_transaction_id: t.external_transaction_id,
        refunded: t.refunded,
        required_info_message: t.required_info_message,
        required_info_updates: t.required_info_updates,
    };
}
/** SEP-31 GET /info — capabilities of the receiving anchor. No auth required. */
router.get("/info", (_req, res) => {
    const receive = {};
    for (const [code, asset] of Object.entries(ASSETS)) {
        receive[code] = {
            enabled: asset.enabled,
            min_amount: asset.min_amount,
            max_amount: asset.max_amount,
            fee_fixed: asset.fee_fixed,
            fee_percent: asset.fee_percent,
            sep12: {
                sender: {
                    types: {
                        "sep31-sender": {
                            description: "U.S. citizens or residents sending remittances",
                        },
                    },
                },
                receiver: {
                    types: {
                        "sep31-receiver": {
                            description: "Receiving customers with a bank or mobile-money account",
                        },
                    },
                },
            },
            fields: { transaction: TRANSACTION_FIELDS },
        };
    }
    res.json({ receive });
});
/** SEP-31 POST /transactions — sending anchor initiates a payment. */
router.post("/transactions", sep10_1.requireSep10, (req, res) => {
    const body = req.body || {};
    const { asset_code, asset_issuer, amount, sender_id, receiver_id } = body;
    const fields = body.fields?.transaction || {};
    if (!asset_code || typeof asset_code !== "string") {
        return badRequest(res, { error: "asset_code is required" });
    }
    const asset = ASSETS[asset_code];
    if (!asset || !asset.enabled) {
        return badRequest(res, { error: `asset_code ${asset_code} is not supported` });
    }
    const numericAmount = Number(amount);
    if (!amount || !Number.isFinite(numericAmount) || numericAmount <= 0) {
        return badRequest(res, { error: "amount must be a positive number" });
    }
    if (numericAmount < asset.min_amount || numericAmount > asset.max_amount) {
        return badRequest(res, {
            error: `amount must be between ${asset.min_amount} and ${asset.max_amount}`,
        });
    }
    if (!customerAccepted(sender_id) || !customerAccepted(receiver_id)) {
        return badRequest(res, { error: "customer_info_needed" });
    }
    const missing = Object.entries(TRANSACTION_FIELDS)
        .filter(([name, spec]) => !spec.optional && !fields[name])
        .map(([name]) => name);
    if (missing.length > 0) {
        const needed = {};
        for (const name of missing)
            needed[name] = TRANSACTION_FIELDS[name];
        return badRequest(res, {
            error: "transaction_info_needed",
            fields: { transaction: needed },
        });
    }
    const id = (0, uuid_1.v4)();
    const fee = asset.fee_fixed + (asset.fee_percent / 100) * numericAmount;
    const now = new Date().toISOString();
    const assetId = asset_issuer
        ? `stellar:${asset_code}:${asset_issuer}`
        : `stellar:${asset_code}`;
    const transaction = {
        id,
        creator: req.sep10.sub,
        status: "pending_sender",
        status_eta: null,
        status_message: null,
        amount_in: numericAmount.toFixed(2),
        amount_in_asset: assetId,
        amount_out: (numericAmount - fee).toFixed(2),
        amount_out_asset: assetId,
        amount_fee: fee.toFixed(2),
        amount_fee_asset: assetId,
        stellar_account_id: config_1.config.signingKeypair.publicKey(),
        stellar_memo_type: "hash",
        stellar_memo: (0, crypto_1.createHash)("sha256").update(id).digest("base64"),
        started_at: now,
        updated_at: now,
        completed_at: null,
        stellar_transaction_id: null,
        external_transaction_id: null,
        refunded: false,
        required_info_message: null,
        required_info_updates: null,
        fields,
        callback_url: null,
    };
    store_1.transactions.set(id, transaction);
    res.status(201).json({
        id,
        stellar_account_id: transaction.stellar_account_id,
        stellar_memo_type: transaction.stellar_memo_type,
        stellar_memo: transaction.stellar_memo,
    });
});
/** SEP-31 GET /transactions/:id — transaction status. */
router.get("/transactions/:id", sep10_1.requireSep10, (req, res) => {
    const transaction = store_1.transactions.get(req.params.id);
    if (!transaction || transaction.creator !== req.sep10.sub) {
        return void res.status(404).json({ error: "transaction not found" });
    }
    res.json({ transaction: publicTransaction(transaction) });
});
/** SEP-31 PATCH /transactions/:id — update fields previously flagged as needed. */
router.patch("/transactions/:id", sep10_1.requireSep10, (req, res) => {
    const transaction = store_1.transactions.get(req.params.id);
    if (!transaction || transaction.creator !== req.sep10.sub) {
        return void res.status(404).json({ error: "transaction not found" });
    }
    if (transaction.status !== "pending_transaction_info_update") {
        return badRequest(res, {
            error: "transaction is not in pending_transaction_info_update status",
        });
    }
    const updates = req.body?.fields?.transaction || {};
    const required = transaction.required_info_updates;
    const expected = Object.keys(required?.transaction ?? {});
    const unexpected = Object.keys(updates).filter((f) => !expected.includes(f));
    if (unexpected.length > 0) {
        return badRequest(res, {
            error: `unexpected transaction fields: ${unexpected.join(", ")}`,
        });
    }
    Object.assign(transaction.fields, updates);
    transaction.status = "pending_receiver";
    transaction.required_info_message = null;
    transaction.required_info_updates = null;
    transaction.updated_at = new Date().toISOString();
    res.json({ transaction: publicTransaction(transaction) });
});
/** SEP-31 PUT /transactions/:id/callback — register a status callback URL. */
router.put("/transactions/:id/callback", sep10_1.requireSep10, (req, res) => {
    const transaction = store_1.transactions.get(req.params.id);
    if (!transaction || transaction.creator !== req.sep10.sub) {
        return void res.status(404).json({ error: "transaction not found" });
    }
    const url = req.body?.url;
    if (!url || typeof url !== "string") {
        return badRequest(res, { error: "url is required" });
    }
    transaction.callback_url = url;
    res.status(204).end();
});
exports.default = router;
//# sourceMappingURL=sep31.js.map