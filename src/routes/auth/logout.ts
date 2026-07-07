import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authService } from "../../services/auth.service.js";

const logoutBodySchema = z.object({
  refreshToken: z.string().min(20),
});

export async function logoutRoutes(app: FastifyInstance) {
  app.post(
    "/logout",
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
            properties: { loggedOut: { type: "boolean" } },
          },
          401: { type: "string" },
        },
      },
    },
    async (request, reply) => {
      const body = logoutBodySchema.parse(request.body);

      try {
        const result = await authService.logout({ refreshToken: body.refreshToken });
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
