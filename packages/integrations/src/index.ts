/**
 * Outside-world adapters (Housecall, vision AI).
 * Depends on @svl/domain. Must not import @svl/mobile or @svl/web.
 */
export { DOMAIN_PACKAGE } from "@svl/domain";

export const INTEGRATIONS_PACKAGE = "@svl/integrations" as const;
