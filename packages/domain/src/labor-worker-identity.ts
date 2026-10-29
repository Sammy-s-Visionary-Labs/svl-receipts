/** Explicitly reviewed source-name identities. No fuzzy matching is performed. */
export interface LaborWorkerAlias {
  readonly alias: string;
  readonly workerName: string;
}

/** The source export uses Last, First while notes can use First Last. */
export function normalizeLaborWorkerName(value: string): string {
  const parts = value.normalize("NFKC").trim().split(",");
  return (parts.length === 2 ? `${parts[1]} ${parts[0]}` : value)
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Compile once per calculation; reject ambiguity rather than choose an identity. */
export function createLaborWorkerIdentityResolver(aliases: readonly LaborWorkerAlias[] = []) {
  const sources = new Set<string>();
  const targets = new Map<string, string>();
  const names = new Map<string, string>();
  for (const item of aliases) {
    if (!item || typeof item.alias !== "string" || typeof item.workerName !== "string")
      throw new Error("Worker identities require exact source and canonical names.");
    const source = normalizeLaborWorkerName(item.alias);
    const target = normalizeLaborWorkerName(item.workerName);
    if (!source || !target || source === target || sources.has(source))
      throw new Error("Repeated or self-referencing worker identities require review.");
    if (targets.has(target) && targets.get(target) !== item.workerName)
      throw new Error("Canonical worker identities require one consistent display name.");
    sources.add(source);
    targets.set(target, item.workerName);
    names.set(source, item.workerName);
  }
  for (const [target, name] of targets) {
    if (sources.has(target)) throw new Error("Worker identity chains and cycles require review.");
    names.set(target, name);
  }
  return (name: string): string => names.get(normalizeLaborWorkerName(name)) ?? name;
}

/** Preserve an unrecognized source name verbatim. */
export function canonicalLaborWorkerName(name: string, aliases: readonly LaborWorkerAlias[] = []) {
  return createLaborWorkerIdentityResolver(aliases)(name);
}
