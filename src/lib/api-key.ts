import crypto from "node:crypto";
import { env, API_KEY_PEPPER } from "../config/env.js";
import argon2 from "argon2";

const API_KEY_PREFIX = "agk";
const API_KEY_SEPARATOR = ".";
const KEY_ID_BYTES = 12;
const SECRET_BYTES = 32;

export interface GeneratedApiKey{
  keyId: string;
  rawSecret: string;
  fullKey: string;
}

export function generateApiKey() : GeneratedApiKey {
  const keyId = crypto.randomBytes(KEY_ID_BYTES).toString("hex");
  const rawSecret = crypto.randomBytes(SECRET_BYTES).toString("hex");
  const fullkey = [API_KEY_PREFIX, keyId, rawSecret].join(API_KEY_SEPARATOR);

  return {
    keyId,
    rawSecret,
    fullKey: fullkey
  };
};

export interface ParsedApiKey {
  keyId : string;
  secret : string;
}

export function parseApiKey(fullKey: string) : ParsedApiKey | null{
  const parts = fullKey.split(API_KEY_SEPARATOR);

  if (parts.length !== 3 ) return null;

  const [prefix, keyId, secret] = parts;

  if (prefix !== API_KEY_PREFIX || !keyId || !secret) return null;

  return { keyId, secret };
};

export async function hashApiKeySecret(secret: string) : Promise<string> {
  return argon2.hash(secret, { secret: API_KEY_PEPPER });
}

export async function verifyApiKeySecret(
  hash : string,
  secret : string
) : Promise<boolean>{
  return argon2.verify(hash, secret, { secret: API_KEY_PEPPER });
}

