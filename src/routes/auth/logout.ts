import type { FastifyInstance } from "fastify";
import { authService } from "../../services/auth.service.js";

export async function logoutRoutes(app: FastifyInstance) {
  app.post(
    "/logout",
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
            properties: { loggedOut: { type: "boolean" } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { refreshToken: string };

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
