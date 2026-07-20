"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const uuid_1 = require("uuid");
const config_1 = require("../config");
const store_1 = require("../store");
const crypto_1 = require("../services/crypto");
const router = (0, express_1.Router)();
// Helper to get SEP-10 auth (placeholder - in real implementation you'd use the existing sep10 middleware)
function getAuthenticatedAccount(req) {
    // For now, we'll use a placeholder that reads from a header
    // In production, use the existing sep10 middleware from middleware/sep10.ts
    return req.headers["x-stellar-account"] || null;
}
/**
 * Create a new tier with initial content key
 * POST /api/v1/tiers
 */
router.post("/", async (req, res) => {
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
        const tierId = (0, uuid_1.v4)();
        const tier = {
            id: tierId,
            creatorAccount,
            name,
            createdAt: new Date().toISOString(),
        };
        store_1.tiers.set(tierId, tier);
        // Generate and store content key
        const contentKey = (0, crypto_1.generateAesKey)();
        const encryptedKey = (0, crypto_1.encryptWithMasterKey)(contentKey, config_1.config.masterEncryptionKey);
        const tierContentKey = {
            id: (0, uuid_1.v4)(),
            tierId,
            encryptedKey,
            keyVersion: 1,
            rotatedAt: null,
            createdAt: new Date().toISOString(),
        };
        store_1.tierContentKeys.set(tierContentKey.id, tierContentKey);
        return res.status(201).json({
            tier,
        });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
/**
 * Upload and encrypt content for a tier
 * POST /api/v1/tiers/:id/content
 */
router.post("/:id/content", async (req, res) => {
    try {
        const creatorAccount = getAuthenticatedAccount(req);
        if (!creatorAccount) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const tierId = req.params.id;
        const tier = (0, store_1.findTierById)(tierId);
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
        const tierContentKey = (0, store_1.findTierContentKeyByTierId)(tierId);
        if (!tierContentKey) {
            return res.status(500).json({ error: "No content key found for tier" });
        }
        // Decrypt content key with master key
        const contentKey = (0, crypto_1.decryptWithMasterKey)(tierContentKey.encryptedKey, config_1.config.masterEncryptionKey);
        // Encrypt the content URL
        const { encryptedData, iv, authTag } = (0, crypto_1.encryptAesGcm)(contentUrl, contentKey);
        // Store encrypted content
        const content = {
            id: (0, uuid_1.v4)(),
            tierId,
            keyVersion: tierContentKey.keyVersion,
            encryptedContentUrl: encryptedData.toString("base64"),
            iv: iv.toString("base64"),
            authTag: authTag.toString("base64"),
            createdAt: new Date().toISOString(),
        };
        store_1.creatorContents.set(content.id, content);
        return res.status(201).json({ content });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
/**
 * Get wrapped content key and content for a tier (for fans with valid pass)
 * GET /api/v1/tiers/:id/content/key
 */
router.get("/:id/content/key", async (req, res) => {
    try {
        const fanAccount = getAuthenticatedAccount(req);
        if (!fanAccount) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const tierId = req.params.id;
        const tier = (0, store_1.findTierById)(tierId);
        if (!tier) {
            return res.status(404).json({ error: "Tier not found" });
        }
        // Check for active pass
        const activePass = (0, store_1.findActivePass)(fanAccount, tierId);
        if (!activePass) {
            return res.status(403).json({ error: "No active pass for this tier" });
        }
        // Get fan public key
        const { fanPublicKey } = req.query;
        if (!fanPublicKey || typeof fanPublicKey !== "string") {
            return res.status(400).json({ error: "fanPublicKey query parameter is required" });
        }
        let fanPublicKeyBuffer;
        try {
            // Stellar public keys are strkey encoded (G...), so we need to decode it
            // For this implementation, we'll assume it's base64 encoded (placeholder)
            fanPublicKeyBuffer = Buffer.from(fanPublicKey, "base64");
        }
        catch (err) {
            return res.status(400).json({ error: "Invalid fanPublicKey" });
        }
        // Convert Ed25519 public key to X25519
        const fanX25519PublicKey = (0, crypto_1.ed25519PublicKeyToX25519)(fanPublicKeyBuffer);
        // Get latest content key
        const tierContentKey = (0, store_1.findTierContentKeyByTierId)(tierId);
        if (!tierContentKey) {
            return res.status(500).json({ error: "No content key found for tier" });
        }
        // Decrypt content key with master key
        const contentKey = (0, crypto_1.decryptWithMasterKey)(tierContentKey.encryptedKey, config_1.config.masterEncryptionKey);
        // Wrap content key with fan's public key
        const wrappedKey = (0, crypto_1.wrapKeyWithEcdh)(contentKey, config_1.config.serverX25519PrivateKey, fanX25519PublicKey);
        // Get content for tier
        const contents = (0, store_1.findCreatorContentsByTierId)(tierId);
        return res.status(200).json({
            wrappedKey,
            keyVersion: tierContentKey.keyVersion,
            serverPublicKey: config_1.config.serverX25519PublicKey.toString("base64"),
            contents,
        });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
/**
 * Rotate content key for a tier
 * POST /api/v1/tiers/:id/content/rotate-key
 */
router.post("/:id/content/rotate-key", async (req, res) => {
    try {
        const creatorAccount = getAuthenticatedAccount(req);
        if (!creatorAccount) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const tierId = req.params.id;
        const tier = (0, store_1.findTierById)(tierId);
        if (!tier) {
            return res.status(404).json({ error: "Tier not found" });
        }
        if (tier.creatorAccount !== creatorAccount) {
            return res.status(403).json({ error: "Not authorized to modify this tier" });
        }
        // Get old content key
        const oldContentKey = (0, store_1.findTierContentKeyByTierId)(tierId);
        if (!oldContentKey) {
            return res.status(500).json({ error: "No content key found for tier" });
        }
        // Mark old key as rotated
        oldContentKey.rotatedAt = new Date().toISOString();
        // Generate new content key
        const newKeyVersion = oldContentKey.keyVersion + 1;
        const newContentKey = (0, crypto_1.generateAesKey)();
        const newEncryptedKey = (0, crypto_1.encryptWithMasterKey)(newContentKey, config_1.config.masterEncryptionKey);
        const newTierContentKey = {
            id: (0, uuid_1.v4)(),
            tierId,
            encryptedKey: newEncryptedKey,
            keyVersion: newKeyVersion,
            rotatedAt: null,
            createdAt: new Date().toISOString(),
        };
        store_1.tierContentKeys.set(newTierContentKey.id, newTierContentKey);
        // NOTE: In a real implementation, you'd also re-encrypt all existing content
        // with the new key or store keys per-content keys so that existing content remains
        // can still be decrypted with the old key (which is what key versioning is for)
        return res.status(200).json({
            newKeyVersion
        });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
/**
 * Create a pass for a fan
 * POST /api/v1/passes
 */
router.post("/passes", async (req, res) => {
    try {
        const { fanAccount, tierId } = req.body;
        if (!fanAccount || !tierId) {
            return res.status(400).json({ error: "fanAccount and tierId are required" });
        }
        const pass = {
            id: (0, uuid_1.v4)(),
            fanAccount,
            tierId,
            active: true,
            createdAt: new Date().toISOString(),
        };
        store_1.passes.set(pass.id, pass);
        return res.status(201).json({ pass });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
exports.default = router;
//# sourceMappingURL=content.js.map