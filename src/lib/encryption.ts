import crypto from "node:crypto";
import {PLATFORM_ENCRYPTION_KEY} from "../config/env.js"

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 12bytes cz GCM requires 96bit size for the IV
const KEY_BYTES = 32;
const HKDF_SALT = Buffer.from("agentgate-hkdf-salt-v1", "utf8"); // salt identifies the application or purpose . A namespace for the entire key derivation process.
const HKDF_INFO_PREFIX = "handler-config-v1:"; // defines the context . A label describing what this derived key will be used for.

function deriveTenantKey(tenantId : string) : Buffer{
  if (PLATFORM_ENCRYPTION_KEY.length != KEY_BYTES) {
    throw new Error(
      `AGENTGATE_PLATFORM_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${PLATFORM_ENCRYPTION_KEY.length})`
    );
  }

  const info = Buffer.from(HKDF_INFO_PREFIX + tenantId, "utf8");

  return Buffer.from(crypto.hkdfSync("sha256" , PLATFORM_ENCRYPTION_KEY , HKDF_SALT , info , KEY_BYTES));

}


/**
 * Stored format: "<iv>:<ciphertext>:<authTag>", each segment base64.
 * ":" is a safe separator here
 */
export function encryptConfig(plaintext : string , tenantId : string) : string {
  const key = deriveTenantKey(tenantId);

  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM , key , iv);

  const cipherText = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    cipherText.toString("base64"),
    authTag.toString("base64")
  ].join(":");

}


export function decryptConfig(stored : string , tenantId : string) : string {

  const [ivB64, cipherTextB64, authTagB64] = stored.split(":");

  if (!ivB64 || !cipherTextB64 || !authTagB64) {
    throw new Error("Malformed ciphertext envelope");
  }

  const key = deriveTenantKey(tenantId);

  const iv = Buffer.from(ivB64, "base64");
  const cipherText = Buffer.from(cipherTextB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);

  return decrypted.toString("utf8");
}