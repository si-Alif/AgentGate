import { afterAll } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { redis } from "../../lib/redis.js";

// Runs once when the (single, serialized) Vitest process exits.
// Individual files handle their own app + tenant cleanup — this
// is the final safety net so the process exits cleanly, and so
// leaked Redis connections don't hang the test runner (a real risk
// once BullMQ workers + pub/sub subscribers exist in Week 5/7).
afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});