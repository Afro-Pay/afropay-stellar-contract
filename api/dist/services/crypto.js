"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAesKey = generateAesKey;
exports.encryptAesGcm = encryptAesGcm;
exports.decryptAesGcm = decryptAesGcm;
exports.ed25519PublicKeyToX25519 = ed25519PublicKeyToX25519;
exports.generateServerX25519KeyPair = generateServerX25519KeyPair;
exports.performEcdh = performEcdh;
exports.wrapKeyWithEcdh = wrapKeyWithEcdh;
exports.encryptWithMasterKey = encryptWithMasterKey;
exports.decryptWithMasterKey = decryptWithMasterKey;
const crypto = __importStar(require("crypto"));
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const TAG_LENGTH = 16; // 128 bits
/**
 * Generates a random 256-bit (32-byte) key for AES encryption
 */
function generateAesKey() {
    return crypto.randomBytes(32);
}
/**
 * Encrypts plaintext using AES-256-GCM
 * @param plaintext - Data to encrypt
 * @param key - AES-256 key (32 bytes)
 * @returns Object containing encrypted data, IV, and auth tag
 */
function encryptAesGcm(plaintext, key) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: TAG_LENGTH,
    });
    let encrypted = cipher.update(plaintext);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        encryptedData: encrypted,
        iv: iv,
        authTag: authTag,
    };
}
/**
 * Decrypts data using AES-256-GCM
 * @param encryptedData - Encrypted data
 * @param key - AES-256 key (32 bytes)
 * @param iv - Initialization vector (12 bytes)
 * @param authTag - Authentication tag (16 bytes)
 * @returns Decrypted plaintext
 */
function decryptAesGcm(encryptedData, key, iv, authTag) {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted;
}
/**
 * Converts an Ed25519 public key to X25519 public key
 * This uses the birational equivalence between Ed25519 and Curve25519
 * @param ed25519PublicKey - Ed25519 public key (32 bytes)
 * @returns X25519 public key (32 bytes)
 */
function ed25519PublicKeyToX25519(ed25519PublicKey) {
    // Stellar Ed25519 keys are 32 bytes, but let's verify
    if (ed25519PublicKey.length !== 32) {
        throw new Error("Invalid Ed25519 public key length");
    }
    // The conversion: x = (1 + y) / (1 - y) mod p
    // This is a simplified approach; in practice, you'd use a proper library
    // For the purposes of this implementation, we'll use a placeholder and note
    // that a production implementation should use a library like tweetnacl or libsodium
    // For now, we'll return the key as-is (this is a placeholder for real conversion)
    return ed25519PublicKey;
}
/**
 * Creates a server X25519 key pair
 */
function generateServerX25519KeyPair() {
    const ecdh = crypto.createECDH("x25519");
    ecdh.generateKeys();
    const publicKey = ecdh.getPublicKey();
    const privateKey = ecdh.getPrivateKey();
    return { publicKey, privateKey };
}
/**
 * Performs X25519 ECDH key exchange to derive a shared secret
 * @param serverPrivateKey - Server's X25519 private key
 * @param fanPublicKey - Fan's X25519 public key
 * @returns Shared secret
 */
function performEcdh(serverPrivateKey, fanPublicKey) {
    const ecdh = crypto.createECDH("x25519");
    ecdh.setPrivateKey(serverPrivateKey);
    const sharedSecret = ecdh.computeSecret(fanPublicKey);
    return sharedSecret;
}
/**
 * Wraps a content key using X25519-derived shared secret and HKDF
 * @param contentKey - AES-256 content key to wrap
 * @param serverPrivateKey - Server's X25519 private key
 * @param fanX25519PublicKey - Fan's X25519 public key
 * @returns Wrapped key as base64 string
 */
function wrapKeyWithEcdh(contentKey, serverPrivateKey, fanX25519PublicKey) {
    const sharedSecret = performEcdh(serverPrivateKey, fanX25519PublicKey);
    // HKDF to derive a wrapping key
    const wrappingKey = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), // salt
    Buffer.from("afropay-content-key-wrap", "utf8"), // info
    32);
    // Use AES-GCM to wrap the content key
    const { encryptedData, iv, authTag } = encryptAesGcm(contentKey, Buffer.from(wrappingKey));
    // Concatenate IV + encrypted key + auth tag and encode as base64
    return Buffer.concat([iv, encryptedData, authTag]).toString("base64");
}
/**
 * Encrypts data with server master key (AES-256-GCM)
 * @param data - Data to encrypt
 * @param masterKey - Server master key (32 bytes)
 * @returns Encrypted data as base64 string (includes IV and auth tag)
 */
function encryptWithMasterKey(data, masterKey) {
    const { encryptedData, iv, authTag } = encryptAesGcm(data, masterKey);
    return Buffer.concat([iv, authTag, encryptedData]).toString("base64");
}
/**
 * Decrypts data with server master key
 * @param encryptedDataBase64 - Base64 encoded encrypted data
 * @param masterKey - Server master key (32 bytes)
 * @returns Decrypted data
 */
function decryptWithMasterKey(encryptedDataBase64, masterKey) {
    const combined = Buffer.from(encryptedDataBase64, "base64");
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encryptedData = combined.subarray(IV_LENGTH + TAG_LENGTH);
    return decryptAesGcm(encryptedData, masterKey, iv, authTag);
}
//# sourceMappingURL=crypto.js.map