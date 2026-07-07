import type { FastifyInstance } from "fastify";
import { authService } from "../../services/auth.service.js";

export async function refreshRoutes(app: FastifyInstance) {
  app.post(
    "/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string", minLength: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
              expiresIn: { type: "number" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { refreshToken: string };

      try {
        const result = await authService.refresh({
          refreshToken: body.refreshToken,
          app,
        });
        return reply.status(200).send(result);
      } catch (err: any) {
        if (err?.message === "INVALID_REFRESH_TOKEN") {
          return reply.unauthorized("Invalid or expired refresh token");
        }
        throw err;
      }
    }
  );
}
