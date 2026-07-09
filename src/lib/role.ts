// src/lib/role.ts (new file)
export const VALID_ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof VALID_ROLES)[number];

export function assertValidRole(role: string): Role {
  if (!VALID_ROLES.includes(role as Role)) {
    throw new Error(`INVARIANT_VIOLATION: unexpected role value "${role}" from database`);
  }
  return role as Role;
}