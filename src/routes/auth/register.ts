import type { FastifyInstance } from 'fastify';
import { authService } from '../../services/auth.service.js';
import { createPublicAuthThrottleHook } from "../../lib/public-auth-throttle.js";

interface RegisterTenantInput {
  tenantName: string
  slug: string
  ownerEmail: string
  password: string
}

export async function registerRoutes(app: FastifyInstance) {
  // POST /auth/register-tenant
  app.post(
    '/register-tenant',
    {
      onRequest: [createPublicAuthThrottleHook("register-tenant")],
      schema: {
        body: {
          type: 'object',
          required: ['tenantName', 'slug', 'ownerEmail', 'password'],
          properties: {
            tenantName: { type: 'string', minLength: 2 },
            slug: { type: 'string', minLength: 2, pattern: '^[a-z0-9-]+$' },
            ownerEmail: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: 'object',
            properties: {
              tenant: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                },
              },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                  // passwordHash is NOT in this schema — it will never appear in response
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await authService.registerTenant(request.body as RegisterTenantInput)
        return reply.status(201).send(result)
      } catch (err: any) {
        if (err.message === "SLUG_TAKEN") {
          return reply.conflict("A tenant with this slug already exists");
        }
        if (err.message === "EMAIL_TAKEN") {
          return reply.conflict("An account with this email already exists");
        }
        if (err.message === "DUPLICATE_ENTRY") {
          return reply.conflict("A conflicting record already exists");
        }
        if (err.message === "INVALID_TOKEN") {
          return reply.badRequest("Invalid verification token");
        }
        throw err;
      }
    }
  )

  app.post(
    '/register-user',
    {
      onRequest: [createPublicAuthThrottleHook("register-user")],
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
        response: {
          201: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  role: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {}
  )
  // GET /auth/verify-email
  app.get(
    '/verify-email',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      try {
        const { token } = request.query as { token: string }
        await authService.verifyEmail(token)
        return reply.send({ message: 'Email verified successfully' })
      } catch (err: any) {
        if (err.message === "INVALID_TOKEN") {
          return reply.badRequest("Invalid verification token");
        }
        throw err;
      }
    }
  )
}