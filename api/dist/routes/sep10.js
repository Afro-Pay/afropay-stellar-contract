"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const config_1 = require("../config");
const router = (0, express_1.Router)();
const horizon = new stellar_sdk_1.Horizon.Server(config_1.config.horizonUrl, { allowHttp: true });
function badRequest(res, message) {
    res.status(400).json({ error: message });
}
/**
 * SEP-10 challenge endpoint.
 * GET <WEB_AUTH_ENDPOINT>?account=...&memo=...&home_domain=...&client_domain=...
 */
router.get("/", (req, res) => {
    const account = req.query.account;
    const memo = req.query.memo;
    const homeDomain = req.query.home_domain;
    const clientDomain = req.query.client_domain;
    if (!account) {
        return badRequest(res, "account is required");
    }
    const isEd25519 = stellar_sdk_1.StrKey.isValidEd25519PublicKey(account);
    const isMuxed = stellar_sdk_1.StrKey.isValidMed25519PublicKey(account);
    if (!isEd25519 && !isMuxed) {
        return badRequest(res, "account is not a valid Stellar account (G... or M...)");
    }
    if (memo !== undefined) {
        if (isMuxed) {
            return badRequest(res, "memo must not be used with muxed accounts (M...)");
        }
        if (!/^\d{1,20}$/.test(memo)) {
            return badRequest(res, "memo must be a valid 64-bit integer (memo of type id)");
        }
    }
    if (homeDomain !== undefined && homeDomain !== config_1.config.homeDomain) {
        return badRequest(res, `home_domain must be ${config_1.config.homeDomain} for this authentication server`);
    }
    if (clientDomain !== undefined) {
        return badRequest(res, "client_domain is not supported by this server");
    }
    try {
        const transaction = stellar_sdk_1.WebAuth.buildChallengeTx(config_1.config.signingKeypair, account, config_1.config.homeDomain, config_1.config.challengeTimeoutSeconds, config_1.config.networkPassphrase, config_1.config.webAuthDomain, memo ?? null);
        res.json({ transaction, network_passphrase: config_1.config.networkPassphrase });
    }
    catch (e) {
        badRequest(res, `unable to build challenge transaction: ${e.message}`);
    }
});
/**
 * SEP-10 token endpoint.
 * POST <WEB_AUTH_ENDPOINT> with {"transaction": "<base64 XDR>"} (JSON or form-encoded).
 */
router.post("/", async (req, res) => {
    const challenge = req.body?.transaction;
    if (!challenge || typeof challenge !== "string") {
        return badRequest(res, "transaction is required");
    }
    let parsed;
    try {
        parsed = stellar_sdk_1.WebAuth.readChallengeTx(challenge, config_1.config.signingKeypair.publicKey(), config_1.config.networkPassphrase, config_1.config.homeDomain, config_1.config.webAuthDomain);
    }
    catch (e) {
        return badRequest(res, `invalid challenge transaction: ${e.message}`);
    }
    const { tx, clientAccountID, memo } = parsed;
    try {
        let clientAccountExists = false;
        let thresholdMet = true;
        try {
            const clientAccount = await horizon.loadAccount(clientAccountID);
            clientAccountExists = true;
            try {
                stellar_sdk_1.WebAuth.verifyChallengeTxThreshold(challenge, config_1.config.signingKeypair.publicKey(), config_1.config.networkPassphrase, clientAccount.thresholds.med_threshold, clientAccount.signers, config_1.config.homeDomain, config_1.config.webAuthDomain);
            }
            catch {
                thresholdMet = false;
            }
        }
        catch (e) {
            if (!(e instanceof stellar_sdk_1.NotFoundError))
                throw e;
        }
        if (!clientAccountExists) {
            // Account not on the ledger yet: challenge must be signed by the master key.
            stellar_sdk_1.WebAuth.verifyChallengeTxSigners(challenge, config_1.config.signingKeypair.publicKey(), config_1.config.networkPassphrase, [clientAccountID], config_1.config.homeDomain, config_1.config.webAuthDomain);
        }
        else if (!thresholdMet) {
            return badRequest(res, "challenge transaction signatures do not meet the account's medium threshold");
        }
    }
    catch (e) {
        return badRequest(res, `challenge verification failed: ${e.message}`);
    }
    const iat = Math.floor(Date.now() / 1000);
    const sub = memo ? `${clientAccountID}:${memo}` : clientAccountID;
    const token = jsonwebtoken_1.default.sign({
        iss: config_1.config.webAuthEndpoint.toString(),
        sub,
        iat,
        exp: iat + config_1.config.jwtExpirySeconds,
        jti: tx.hash().toString("hex"),
    }, config_1.config.jwtSecret);
    res.json({ token });
});
exports.default = router;
//# sourceMappingURL=sep10.js.map