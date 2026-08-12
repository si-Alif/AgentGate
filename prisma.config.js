import "dotenv/config";
import { defineConfig } from "prisma/config";

const dbUrl = process.env.AGENTGATE_DATABASE_URL;

if (!dbUrl) {
  console.error(
    "[prisma.config] ERROR: Neither AGENTGATE_DATABASE_URL nor DATABASE_URL is set in environment."
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: dbUrl,
  },
});

