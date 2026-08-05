export const VALID_ROLES = ["owner", "member"] as const;

export type Role = (typeof VALID_ROLES)[number];

export function isValidRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}