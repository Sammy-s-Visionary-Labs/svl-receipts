import { isUserRole, type UserRole } from "./roles";

/** Stable API error codes. Response bodies must not include receipt contents. */
export const AUTH_ERROR_CODES = {
  accountInactive: "account_inactive",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * Server-resolved identity. Role and disabled MUST come from `profiles`,
 * never from a client-supplied field.
 */
export type AuthzActor = {
  userId: string;
  role: UserRole;
  disabled: boolean;
};

export function parseUserRole(value: unknown): UserRole | null {
  return typeof value === "string" && isUserRole(value) ? value : null;
}

export function isStaffRole(role: UserRole): boolean {
  return role === "manager" || role === "admin";
}

export function actorMayUseApp(actor: AuthzActor): boolean {
  return !actor.disabled;
}

export function actorMayAccessManagerOps(actor: AuthzActor): boolean {
  return actorMayUseApp(actor) && isStaffRole(actor.role);
}

export function actorMayAccessAdminOps(actor: AuthzActor): boolean {
  return actorMayUseApp(actor) && actor.role === "admin";
}

/** Workers: own receipts only. Manager/admin: any receipt. */
export function actorMayReadReceipt(actor: AuthzActor, ownerUserId: string): boolean {
  if (!actorMayUseApp(actor)) {
    return false;
  }
  if (isStaffRole(actor.role)) {
    return true;
  }
  return actor.userId === ownerUserId;
}
