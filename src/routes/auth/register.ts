import type { FastifyInstance } from 'fastify';
import { authService } from '../../services/auth.service.js';
import { createPublicAuthThrottleHook } from "../../lib/public-auth-throttle.js";
import { invitationService } from "../../services/invitation.service.js";

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
    '/accept-invitation',
    {
      onRequest: [createPublicAuthThrottleHook("accept-invitation")],
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            email: { type: 'string', minLength: 1 },
            password: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { token, password } = request.body as { token: string; password: string };
      const result = await invitationService.acceptInvitation(token, password);

      if (!result.ok) {
        if (result.reason === "email_taken") {
          return reply.conflict("An account with this email already exists. Try logging in instead.");
        }

        // not_found / revoked / already_accepted / expired /
        // tenant_suspended all collapse to ONE generic message —
        // never a distinct oracle for which specific token-state
        // failure occurred. Note this holds regardless of whether a
        // stray `role` field in the request body was stripped or
        // rejected by the schema above — acceptInvitation()'s own
        // signature (rawToken, password) never reads one either way.
        return reply.badRequest("This invitation is no longer valid.");
      }

      const tokens = await authService.issueSessionTokens(result.user , app);
      return reply.status(200).send(tokens);

    }
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