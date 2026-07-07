import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authService } from "../../services/auth.service.js";

const refreshBodySchema = z.object({
  refreshToken: z.string().min(20),
});

export async function refreshRoutes(app: FastifyInstance) {
  app.post(
    "/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string" },
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
          401: { type: "string" },
        },
      },
    },
    async (request, reply) => {
      const body = refreshBodySchema.parse(request.body);

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
