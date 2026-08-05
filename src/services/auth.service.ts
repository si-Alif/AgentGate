import argon2 from "argon2";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "@prisma/client";
import { tenantRepository } from "../repositories/tenant.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { PASSWORD_PEPPER, REFRESH_TOKEN_SECRET } from "../config/env.js";
import { assertValidRole } from "../lib/role.js";
import { enqueueVerificationEmail } from '../queue/email.queue.js';

import type { FastifyInstance } from "fastify";

const DUMMY_PASSWORD = "dummy-password-for-timing-parity";
let dummyPasswordHashPromise: Promise<string> | null = null;

async function getDummyPasswordHash() {
  if (!dummyPasswordHashPromise) {
    dummyPasswordHashPromise = argon2.hash(DUMMY_PASSWORD, {
      secret: PASSWORD_PEPPER,
    });
  }
  return dummyPasswordHashPromise;
}

/**
 * The ONE place a refresh token is ever hashed, anywhere in this
 * file. Deliberately HMAC-SHA256, never Argon2:
 *
 * - A refresh token is a 256-bit, machine-generated random value
 *   (crypto.randomBytes(32)) — not a low-entropy, human-chosen
 *   secret like a password. There's no dictionary to brute-force,
 *   so Argon2's deliberate slowness defends against a threat that
 *   doesn't exist here.
 * - More importantly: refresh has to look this token up by VALUE
 *   (it's the only identifier the server receives) via
 *   `findByRefreshTokenHash(hash)`. That requires a DETERMINISTIC
 *   hash — same input always produces the same output. Argon2
 *   salts randomly per call and can only be used with
 *   argon2.verify(knownHash, token) once you already know which
 *   hash to check — it structurally cannot serve a lookup-by-value
 *   query. HMAC-SHA256, keyed by a server-only secret, gives the
 *   same one-way, can't-invert-without-the-key property while
 *   staying deterministic.
 *
 * Every caller in this file (issueSessionTokens, login, refresh,
 * logout) MUST go through this one function — using a different
 * hash construction in even one of them silently breaks refresh
 * for whichever path used it (this fixes exactly that bug in
 * issueSessionTokens, which previously used argon2.hash() while
 * refresh()/logout() looked up via this HMAC).
 */
function hashRefreshToken(rawRefreshToken: string): string {
  return crypto
    .createHmac("sha256", REFRESH_TOKEN_SECRET)
    .update(rawRefreshToken)
    .digest("hex");
}

export const authService = {
  async issueSessionTokens(
    user: { id: string; tenantId: string; role: string },
    app: FastifyInstance
  ) {
    const accessToken = await app.jwt.sign(
      {
        tenantId: user.tenantId,
        userId: user.id,
        role: assertValidRole(user.role),
      },
      { expiresIn: "15m" }
    );

    const rawRefreshToken = crypto.randomBytes(32).toString("base64url");
    const refreshTokenHash = hashRefreshToken(rawRefreshToken);
    await userRepository.updateRefreshTokenHash(user.id, user.tenantId, refreshTokenHash);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 900, // 15 minutes in seconds
    };
  },

  async registerTenant(data: {
    tenantName: string;
    slug: string;
    ownerEmail: string;
    password: string;
  }) {
    const existingTenant = await tenantRepository.findBySlug(data.slug);
    if (existingTenant) throw new Error("SLUG_TAKEN");

    const hashedPassword = await argon2.hash(data.password, { secret: PASSWORD_PEPPER });

    const verificationToken = crypto.randomUUID();

    try {
      const res = await prisma.$transaction(async (tx) => {
        const tenant = await tenantRepository.create({ name: data.tenantName, slug: data.slug }, tx);
        const user = await userRepository.create(
          { tenantId: tenant.id, email: data.ownerEmail, passwordHash: hashedPassword, role: "owner", verificationToken },
          tx
        );
        return { tenant, user };
      });

      enqueueVerificationEmail({ userId: res.user.id, email: res.user.email, token: verificationToken });

      return { tenant: res.tenant, user: { id: res.user.id, email: res.user.email, role: res.user.role } };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = Array.isArray(err.meta?.target) ? err.meta.target.join(",") : String(err.meta?.target ?? "");
        if (target.includes("email")) throw new Error("EMAIL_TAKEN");
        if (target.includes("slug")) throw new Error("SLUG_TAKEN");
        throw new Error("DUPLICATE_ENTRY");
      }
      throw err;
    }
  },

  async verifyEmail(token: string) {
    const user = await userRepository.findByVerificationToken(token);
    if (!user) throw new Error("INVALID_TOKEN");

    // Apply verification side-effects.
    // updateVerified() is responsible for:
    // - isVerified = true
    // - verificationToken = null
    await userRepository.updateVerified(user.id, user.tenantId);

    return { verified: true };
  },

  async login(params: {
    email: string;
    password: string;
    app: FastifyInstance;
  }) {
    const { email, password, app } = params;

    const user = await userRepository.findByEmail(email);

    // Timing-side-channel mitigation:
    // Always perform argon2.verify work, even if user doesn't exist.
    const dummyHash = await getDummyPasswordHash();
    const passwordHashToVerify = user?.passwordHash ?? dummyHash;

    const passwordValid = await argon2.verify(passwordHashToVerify, password, {
      secret: PASSWORD_PEPPER,
    });

    // Non-enumerating auth failure: wrong email and wrong password share the same error.
    if (!user || !passwordValid) throw new Error("INVALID_CREDENTIALS");
    if (!user.isVerified) throw new Error("EMAIL_NOT_VERIFIED");

    // Access token — minimal payload (identity only)
    const accessToken = await app.jwt.sign(
      {
        tenantId: user.tenantId,
        userId: user.id,
        role: assertValidRole(user.role),
      },
      { expiresIn: "15m" }
    );

    // Refresh token strategy (schema-compatible):
    // Store only a deterministic keyed hash (never plaintext), so we can look up the user.
    const rawRefreshToken = crypto.randomBytes(32).toString("base64url");
    const refreshTokenHash = hashRefreshToken(rawRefreshToken);

    await userRepository.updateRefreshTokenHash(user.id, user.tenantId, refreshTokenHash);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 900, // 15 minutes in seconds
    };
  },

  async refresh(params: { refreshToken: string; app: FastifyInstance }) {
    const { refreshToken, app } = params;

    const refreshTokenHash = hashRefreshToken(refreshToken);

    const user = await userRepository.findByRefreshTokenHash(refreshTokenHash);
    if (!user || !user.isVerified) throw new Error("INVALID_REFRESH_TOKEN");

    const accessToken = await app.jwt.sign(
      {
        tenantId: user.tenantId,
        userId: user.id,
        role: assertValidRole(user.role),
      },
      { expiresIn: "15m" }
    );

    return { accessToken, expiresIn: 900 };
  },

  async logout(params: { refreshToken: string }) {
    const { refreshToken } = params;

    const refreshTokenHash = hashRefreshToken(refreshToken);

    const user = await userRepository.findByRefreshTokenHash(refreshTokenHash);
    if (!user) throw new Error("INVALID_REFRESH_TOKEN");

    await userRepository.updateRefreshTokenHash(user.id, user.tenantId, null);
    return { loggedOut: true };
  },
};