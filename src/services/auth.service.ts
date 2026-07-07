import argon2 from "argon2";
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import { tenantRepository } from "../repositories/tenant.repository.js";
import { userRepository } from "../repositories/user.repository.js";
import { emailQueue } from "../queue/email.queue.js";
import { PASSWORD_PEPPER } from "../config/env.js"

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
      const tenant = await tenantRepository.create({
        name: data.tenantName,
        slug: data.slug,
      }, tx);

      const user = await userRepository.create({
        tenantId: tenant.id,
        email: data.ownerEmail,
        passwordHash: hashedPassword,
        role: "owner",
        verificationToken: verificationToken,
      }, tx);

      return { tenant, user };
    })

    emailQueue.add("verification", {
      type: "verification",
      email: data.ownerEmail,
      token: verificationToken,
    }).catch((err) => {
      console.error("[EMAIL QUEUE] Failed to enqueue:", err);
    })

    return {
      tenant: res.tenant,
      user: {
        id: res.user.id,
        email: res.user.email,
        role: res.user.role
      }
    }
  },

  async verifyEmail(token: string) {
    const user = await userRepository.findByVerificationToken(token);
    if (!user) throw new Error("INVALID_TOKEN");
    await userRepository.updateVerified(user.id);
    return {
      verified: true,
    }
  }
}
