/** Roles enforced at the server boundary (not only in UI navigation). */
export const USER_ROLES = ["worker", "manager", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}
