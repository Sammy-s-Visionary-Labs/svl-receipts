import { parseUserRole, type UserRole } from "@svl/domain";

export type AuthPhase =
  | "booting"
  | "signed_out"
  | "needs_network"
  | "inactive"
  | "wrong_role"
  | "ready";

export type IdentityError = "network" | "inactive";

export function resolveAuthPhase(input: {
  booting: boolean;
  hasSession: boolean;
  role: UserRole | null;
  error: IdentityError | null;
}): AuthPhase {
  if (input.booting) {
    return "booting";
  }
  if (!input.hasSession) {
    return "signed_out";
  }
  if (input.role === "worker") {
    return "ready";
  }
  if (input.role === "manager" || input.role === "admin") {
    return "wrong_role";
  }
  if (input.error === "inactive") {
    return "inactive";
  }
  if (input.error === "network") {
    return "needs_network";
  }
  return "booting";
}

export type AuthDestination = "booting" | "login" | "offline" | "blocked" | "tabs";

export function destinationForPhase(phase: AuthPhase): AuthDestination {
  switch (phase) {
    case "booting":
      return "booting";
    case "signed_out":
      return "login";
    case "needs_network":
      return "offline";
    case "inactive":
    case "wrong_role":
      return "blocked";
    case "ready":
      return "tabs";
  }
}

export type MeIdentity = {
  userId: string;
  role: UserRole;
};

export function parseMeIdentity(value: unknown): MeIdentity | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as { userId?: unknown; role?: unknown };
  if (typeof candidate.userId !== "string" || candidate.userId.length === 0) {
    return null;
  }
  const role = parseUserRole(candidate.role);
  if (!role) {
    return null;
  }
  return { userId: candidate.userId, role };
}
