import express, { Request, Response, Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config";
import {
  tiers,
  tierContentKeys,
  creatorContents,
  passes,
  findTierById,
  findTierContentKeyByTierId,
  findAllTierContentKeysByTierId,
  findCreatorContentsByTierId,
  findActivePass,
  Tier,
  TierContentKey,
  CreatorContent,
  Pass,
} from "../store";
import {
  generateAesKey,
  encryptAesGcm,
  decryptAesGcm,
  encryptWithMasterKey,
  decryptWithMasterKey,
  wrapKeyWithEcdh,
  ed25519PublicKeyToX25519,
} from "../services/crypto";

const router = Router();

// Helper to get SEP-10 auth (placeholder - in real implementation you'd use the existing sep10 middleware)
function getAuthenticatedAccount(req: Request): string | null {
  // For now, we'll use a placeholder that reads from a header
  // In production, use the existing sep10 middleware from middleware/sep10.ts
  return req.headers["x-stellar-account"] as string || null;
}

/**
 * Create a new tier with initial content key
 * POST /api/v1/tiers
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const creatorAccount = getAuthenticatedAccount(req);
    if (!creatorAccount) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    // Create tier
    const tierId = uuidv4();
    const tier: Tier = {
      id: tierId,
      creatorAccount,
      name,
      createdAt: new Date().toISOString(),
    };
    tiers.set(tierId, tier);

    // Generate and store content key
    const contentKey = generateAesKey();
    const encryptedKey = encryptWithMasterKey(contentKey, config.masterEncryptionKey);
    const tierContentKey: TierContentKey = {
      id: uuidv4(),
      tierId,
      encryptedKey,
      keyVersion: 1,
      rotatedAt: null,
      createdAt: new Date().toISOString(),
    };
    tierContentKeys.set(tierContentKey.id, tierContentKey);

    return res.status(201).json({
      tier,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Upload and encrypt content for a tier
 * POST /api/v1/tiers/:id/content
 */
router.post("/:id/content", async (req: Request, res: Response) => {
  try {
    const creatorAccount = getAuthenticatedAccount(req);
    if (!creatorAccount) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tierId = req.params.id;
    const tier = findTierById(tierId);

    if (!tier) {
      return res.status(404).json({ error: "Tier not found" });
    }

    if (tier.creatorAccount !== creatorAccount) {
      return res.status(403).json({ error: "Not authorized to modify this tier" });
    }

    const { contentUrl } = req.body;
    if (!contentUrl) {
      return res.status(400).json({ error: "contentUrl is required" });
    }

    // Get latest content key
    const tierContentKey = findTierContentKeyByTierId(tierId);
    if (!tierContentKey) {
      return res.status(500).json({ error: "No content key found for tier" });
    }

    // Decrypt content key with master key
    const contentKey = decryptWithMasterKey(tierContentKey.encryptedKey, config.masterEncryptionKey);

    // Encrypt the content URL
    const { encryptedData, iv, authTag } = encryptAesGcm(contentUrl, contentKey);

    // Store encrypted content
    const content: CreatorContent = {
      id: uuidv4(),
      tierId,
      keyVersion: tierContentKey.keyVersion,
      encryptedContentUrl: encryptedData.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      createdAt: new Date().toISOString(),
    };
    creatorContents.set(content.id, content);

    return res.status(201).json({ content });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Get wrapped content key and content for a tier (for fans with valid pass)
 * GET /api/v1/tiers/:id/content/key
 */
router.get("/:id/content/key", async (req: Request, res: Response) => {
  try {
    const fanAccount = getAuthenticatedAccount(req);
    if (!fanAccount) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tierId = req.params.id;
    const tier = findTierById(tierId);

    if (!tier) {
      return res.status(404).json({ error: "Tier not found" });
    }

    // Check for active pass
    const activePass = findActivePass(fanAccount, tierId);
    if (!activePass) {
      return res.status(403).json({ error: "No active pass for this tier" });
    }

    // Get fan public key
    const { fanPublicKey } = req.query;
    if (!fanPublicKey || typeof fanPublicKey !== "string") {
      return res.status(400).json({ error: "fanPublicKey query parameter is required" });
    }

    let fanPublicKeyBuffer: Buffer;
    try {
      // Stellar public keys are strkey encoded (G...), so we need to decode it
      // For this implementation, we'll assume it's base64 encoded (placeholder)
      fanPublicKeyBuffer = Buffer.from(fanPublicKey, "base64");
    } catch (err) {
      return res.status(400).json({ error: "Invalid fanPublicKey" });
    }

    // Convert Ed25519 public key to X25519
    const fanX25519PublicKey = ed25519PublicKeyToX25519(fanPublicKeyBuffer);

    // Get latest content key
    const tierContentKey = findTierContentKeyByTierId(tierId);
    if (!tierContentKey) {
      return res.status(500).json({ error: "No content key found for tier" });
    }

    // Decrypt content key with master key
    const contentKey = decryptWithMasterKey(tierContentKey.encryptedKey, config.masterEncryptionKey);

    // Wrap content key with fan's public key
    let wrappedKey: string;
    try {
      wrappedKey = wrapKeyWithEcdh(contentKey, config.serverX25519PrivateKey, fanX25519PublicKey);
    } catch (err) {
      return res.status(400).json({ error: "Invalid fanPublicKey" });
    }

    // Get content for tier
    const contents = findCreatorContentsByTierId(tierId);

    return res.status(200).json({
      wrappedKey,
      keyVersion: tierContentKey.keyVersion,
      serverPublicKey: config.serverX25519PublicKey.toString("base64"),
      contents,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Rotate content key for a tier
 * POST /api/v1/tiers/:id/content/rotate-key
 */
router.post("/:id/content/rotate-key", async (req: Request, res: Response) => {
  try {
    const creatorAccount = getAuthenticatedAccount(req);
    if (!creatorAccount) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const tierId = req.params.id;
    const tier = findTierById(tierId);

    if (!tier) {
      return res.status(404).json({ error: "Tier not found" });
    }

    if (tier.creatorAccount !== creatorAccount) {
      return res.status(403).json({ error: "Not authorized to modify this tier" });
    }

    // Get old content key
    const oldContentKey = findTierContentKeyByTierId(tierId);
    if (!oldContentKey) {
      return res.status(500).json({ error: "No content key found for tier" });
    }

    // Mark old key as rotated
    oldContentKey.rotatedAt = new Date().toISOString();

    // Generate new content key
    const newKeyVersion = oldContentKey.keyVersion + 1;
    const newContentKey = generateAesKey();
    const newEncryptedKey = encryptWithMasterKey(newContentKey, config.masterEncryptionKey);
    const newTierContentKey: TierContentKey = {
      id: uuidv4(),
      tierId,
      encryptedKey: newEncryptedKey,
      keyVersion: newKeyVersion,
      rotatedAt: null,
      createdAt: new Date().toISOString(),
    };
    tierContentKeys.set(newTierContentKey.id, newTierContentKey);

    // NOTE: In a real implementation, you'd also re-encrypt all existing content
    // with the new key or store keys per-content keys so that existing content remains
    // can still be decrypted with the old key (which is what key versioning is for)
    return res.status(200).json({
      newKeyVersion });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Create a pass for a fan
 * POST /api/v1/passes
 */
router.post("/passes", async (req: Request, res: Response) => {
  try {
    const { fanAccount, tierId } = req.body;
    if (!fanAccount || !tierId) {
      return res.status(400).json({ error: "fanAccount and tierId are required" });
    }

    const pass: Pass = {
      id: uuidv4(),
      fanAccount,
      tierId,
      active: true,
      createdAt: new Date().toISOString(),
    };
    passes.set(pass.id, pass);

    return res.status(201).json({ pass });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
