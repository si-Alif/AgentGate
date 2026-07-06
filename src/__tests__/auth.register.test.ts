import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';

async function cleanupDatabase() {
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}

describe('Day 3 auth flow', () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  it('creates a tenant and owner user without leaking secrets', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register-tenant',
        payload: {
          tenantName: 'Acme Corp',
          slug: 'acme-corp',
          ownerEmail: 'owner@acme.test',
          password: 'StrongPass123!',
        },
      });

      expect(response.statusCode).toBe(201);

      const body = response.json() as {
        tenant: { id: string; name: string; slug: string };
        user: { id: string; email: string; role: string };
      };

      expect(body.tenant.slug).toBe('acme-corp');
      expect(body.user.email).toBe('owner@acme.test');
      expect(body.user.role).toBe('owner');
      expect('passwordHash' in (body.user as Record<string, unknown>)).toBe(false);
      expect('verificationToken' in (body.user as Record<string, unknown>)).toBe(false);

      const storedUser = await prisma.user.findUnique({
        where: { email: 'owner@acme.test' },
      });

      expect(storedUser).not.toBeNull();
      expect(storedUser?.passwordHash.startsWith('$argon2')).toBe(true);
      expect(storedUser?.passwordHash).not.toBe('StrongPass123!');
      expect(storedUser?.isVerified).toBe(false);
      expect(storedUser?.verificationToken).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it('returns 409 when tenant slug already exists', async () => {
    const app = await createApp();
    try {
      const payload = {
        tenantName: 'Acme Corp',
        slug: 'acme-corp',
        ownerEmail: 'owner@acme.test',
        password: 'StrongPass123!',
      };

      const first = await app.inject({
        method: 'POST',
        url: '/auth/register-tenant',
        payload,
      });

      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/auth/register-tenant',
        payload: {
          ...payload,
          ownerEmail: 'different-owner@acme.test',
        },
      });

      expect(second.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it('returns 400 for invalid registration payloads', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register-tenant',
        payload: {
          tenantName: 'A',
          slug: 'Bad Slug',
          ownerEmail: 'not-an-email',
          password: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('verifies email and clears the verification token', async () => {
    const app = await createApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/auth/register-tenant',
        payload: {
          tenantName: 'Acme Corp',
          slug: 'acme-corp',
          ownerEmail: 'owner@acme.test',
          password: 'StrongPass123!',
        },
      });

      const userBeforeVerify = await prisma.user.findUnique({
        where: { email: 'owner@acme.test' },
      });

      expect(userBeforeVerify?.verificationToken).toBeTruthy();

      const verifyResponse = await app.inject({
        method: 'GET',
        url: `/auth/verify-email?token=${userBeforeVerify?.verificationToken}`,
      });

      expect(verifyResponse.statusCode).toBe(200);

      const userAfterVerify = await prisma.user.findUnique({
        where: { email: 'owner@acme.test' },
      });

      expect(userAfterVerify?.isVerified).toBe(true);
      expect(userAfterVerify?.verificationToken).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns 400 for an invalid verification token', async () => {
    const app = await createApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/verify-email?token=does-not-exist',
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});