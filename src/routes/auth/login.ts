import type { FastifyInstance } from "fastify";
import { authService } from "../../services/auth.service.js";
import { createPublicAuthThrottleHook } from "../../lib/public-auth-throttle.js";

export async function loginRoutes(app: FastifyInstance) {
  app.post(
    "/login",
    {
    onRequest: [createPublicAuthThrottleHook("login")],
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
              refreshToken: { type: "string" },
              expiresIn: { type: "number" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        password: string;
      };

      try {
        const result = await authService.login({
          email: body.email,
          password: body.password,
          app,
        });

        return reply.status(200).send(result);
      } catch (err: any) {
        if (err?.message === "INVALID_CREDENTIALS") {
          return reply.unauthorized("Invalid email or password");
        }
        if (err?.message === "EMAIL_NOT_VERIFIED") {
          return reply.forbidden("Email not verified");
        }
        throw err;
      }
    }
  );
}
