import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Horizon, NotFoundError, StrKey, WebAuth } from "@stellar/stellar-sdk";
import { config } from "../config";

const router = Router();
const horizon = new Horizon.Server(config.horizonUrl, { allowHttp: true });

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/**
 * SEP-10 challenge endpoint.
 * GET <WEB_AUTH_ENDPOINT>?account=...&memo=...&home_domain=...&client_domain=...
 */
router.get("/", (req: Request, res: Response) => {
  const account = req.query.account as string | undefined;
  const memo = req.query.memo as string | undefined;
  const homeDomain = req.query.home_domain as string | undefined;
  const clientDomain = req.query.client_domain as string | undefined;

  if (!account) {
    return badRequest(res, "account is required");
  }
  const isEd25519 = StrKey.isValidEd25519PublicKey(account);
  const isMuxed = StrKey.isValidMed25519PublicKey(account);
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

  if (homeDomain !== undefined && homeDomain !== config.homeDomain) {
    return badRequest(
      res,
      `home_domain must be ${config.homeDomain} for this authentication server`
    );
  }

  if (clientDomain !== undefined) {
    return badRequest(res, "client_domain is not supported by this server");
  }

  try {
    const transaction = WebAuth.buildChallengeTx(
      config.signingKeypair,
      account,
      config.homeDomain,
      config.challengeTimeoutSeconds,
      config.networkPassphrase,
      config.webAuthDomain,
      memo ?? null
    );
    res.json({ transaction, network_passphrase: config.networkPassphrase });
  } catch (e) {
    badRequest(res, `unable to build challenge transaction: ${(e as Error).message}`);
  }
});

/**
 * SEP-10 token endpoint.
 * POST <WEB_AUTH_ENDPOINT> with {"transaction": "<base64 XDR>"} (JSON or form-encoded).
 */
router.post("/", async (req: Request, res: Response) => {
  const challenge = req.body?.transaction;
  if (!challenge || typeof challenge !== "string") {
    return badRequest(res, "transaction is required");
  }

  let parsed: ReturnType<typeof WebAuth.readChallengeTx>;
  try {
    parsed = WebAuth.readChallengeTx(
      challenge,
      config.signingKeypair.publicKey(),
      config.networkPassphrase,
      config.homeDomain,
      config.webAuthDomain
    );
  } catch (e) {
    return badRequest(res, `invalid challenge transaction: ${(e as Error).message}`);
  }

  const { tx, clientAccountID, memo } = parsed;

  try {
    let clientAccountExists = false;
    let thresholdMet = true;
    try {
      const clientAccount = await horizon.loadAccount(clientAccountID);
      clientAccountExists = true;
      try {
        WebAuth.verifyChallengeTxThreshold(
          challenge,
          config.signingKeypair.publicKey(),
          config.networkPassphrase,
          clientAccount.thresholds.med_threshold,
          clientAccount.signers,
          config.homeDomain,
          config.webAuthDomain
        );
      } catch {
        thresholdMet = false;
      }
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }

    if (!clientAccountExists) {
      // Account not on the ledger yet: challenge must be signed by the master key.
      WebAuth.verifyChallengeTxSigners(
        challenge,
        config.signingKeypair.publicKey(),
        config.networkPassphrase,
        [clientAccountID],
        config.homeDomain,
        config.webAuthDomain
      );
    } else if (!thresholdMet) {
      return badRequest(
        res,
        "challenge transaction signatures do not meet the account's medium threshold"
      );
    }
  } catch (e) {
    return badRequest(res, `challenge verification failed: ${(e as Error).message}`);
  }

  const iat = Math.floor(Date.now() / 1000);
  const sub = memo ? `${clientAccountID}:${memo}` : clientAccountID;
  const token = jwt.sign(
    {
      iss: config.webAuthEndpoint.toString(),
      sub,
      iat,
      exp: iat + config.jwtExpirySeconds,
      jti: tx.hash().toString("hex"),
    },
    config.jwtSecret
  );

  res.json({ token });
});

export default router;
