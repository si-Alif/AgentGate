import argon2 from "argon2";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { tenantRepository } from "../repositories/tenant.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { emailQueue } from "../queue/email.queue.js";
import { PASSWORD_PEPPER } from "../config/env.js"

import type { FastifyInstance } from "fastify";

export const authService = {
  async registerTenant(data: {
    tenantName: string
    slug: string
    ownerEmail: string
    password: string
  }) {
    const existingUser = await tenantRepository.findBySlug(data.slug);
    if (existingUser) throw new Error("SLUG_TAKEN");

    const hashedPassword = await argon2.hash(data.password, { secret: PASSWORD_PEPPER });

    const verificationToken = crypto.randomUUID();

    const res = await prisma.$transaction(async (tx) => {
      const tenant = await tenantRepository.create(
        {
          name: data.tenantName,
          slug: data.slug,
        },
        tx
      );

      const user = await userRepository.create(
        {
          tenantId: tenant.id,
          email: data.ownerEmail,
          passwordHash: hashedPassword,
          role: "owner",
          verificationToken: verificationToken,
        },
        tx
      );

      return { tenant, user };
    });

    emailQueue
      .add("verification", {
        type: "verification",
        email: data.ownerEmail,
        token: verificationToken,
      })
      .catch((err) => {
        console.error("[EMAIL QUEUE] Failed to enqueue:", err);
      });

    return {
      tenant: res.tenant,
      user: {
        id: res.user.id,
        email: res.user.email,
        role: res.user.role,
      },
    };
  },

  async verifyEmail(token: string) {
    const user = await userRepository.findByVerificationToken(token);
    if (!user) throw new Error("INVALID_TOKEN");

    // Apply verification side-effects.
    // updateVerified() is responsible for:
    // - isVerified = true
    // - verificationToken = null
    await userRepository.updateVerified(user.id);

    return { verified: true };
  },

  async login(params: {
    email: string;
    password: string;
    app: FastifyInstance;
  }) {
    const { email, password, app } = params;

    const user = await userRepository.findByEmail(email);
    if (!user) throw new Error("INVALID_CREDENTIALS");

    const passwordValid = await argon2.verify(user.passwordHash, password, {
      secret: PASSWORD_PEPPER,
    });

    // Non-enumerating auth failure: wrong email and wrong password share the same error.
    if (!passwordValid) throw new Error("INVALID_CREDENTIALS");
    if (!user.isVerified) throw new Error("EMAIL_NOT_VERIFIED");

    // Access token — minimal payload (identity only)
    const accessToken = await app.jwt.sign(
      {
        tenantId: user.tenantId,
        userId: user.id,
        role: user.role as "owner" | "admin" | "member",
      },
      { expiresIn: "15m" }
    );

    // Refresh token strategy (schema-compatible):
    // Store only a deterministic keyed hash (never plaintext), so we can look up the user.
    const rawRefreshToken = crypto.randomBytes(32).toString("base64url");
    const refreshTokenHash = crypto
      .createHmac("sha256", PASSWORD_PEPPER)
      .update(rawRefreshToken)
      .digest("hex");

    await userRepository.updateRefreshTokenHash(user.id, refreshTokenHash);

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: 900, // 15 minutes in seconds
    };
  },

  async refresh(params: { refreshToken: string; app: FastifyInstance }) {
    const { refreshToken, app } = params;

    const refreshTokenHash = crypto
      .createHmac("sha256", PASSWORD_PEPPER)
      .update(refreshToken)
      .digest("hex");

    const user = await userRepository.findByRefreshTokenHash(refreshTokenHash);
    if (!user || !user.isVerified) throw new Error("INVALID_REFRESH_TOKEN");

    const accessToken = await app.jwt.sign(
      {
        tenantId: user.tenantId,
        userId: user.id,
        role: user.role as "owner" | "admin" | "member",
      },
      { expiresIn: "15m" }
    );

    return { accessToken, expiresIn: 900 };
  },

  async logout(params: { refreshToken: string }) {
    const { refreshToken } = params;

    const refreshTokenHash = crypto
      .createHmac("sha256", PASSWORD_PEPPER)
      .update(refreshToken)
      .digest("hex");

    const user = await userRepository.findByRefreshTokenHash(refreshTokenHash);
    if (!user) throw new Error("INVALID_REFRESH_TOKEN");

    await userRepository.updateRefreshTokenHash(user.id, null);
    return { loggedOut: true };
  },
};
