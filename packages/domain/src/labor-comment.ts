/** A job-name comment or an explicit correction scoped to its note owner and work date. */
export interface LaborJobComment {
  readonly sourceAlias: string | null;
  readonly destinationAlias: string;
}

const normalizeAlias = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Parse only the observed daily-comment forms. Callers must resolve the entire
 * returned alias against reviewed customer names/aliases and retain ambiguity.
 * This does not interpret free-form instructions or infer a global job alias.
 */
export function parseLaborJobComment(value: string): LaborJobComment | null {
  let text = normalizeAlias(value);
  if (!text) return null;

  // Supercrew's Other category may be joined to the entered note by a separator.
  text = text.replace(/^other(?:\s*[-:]\s*|\s+)/, "");
  // Some exported correction notes omit the separator: OtherDavis = Johnson.
  if (/^other[^=]+=[^=]+$/.test(text)) text = text.slice("other".length);

  const equalParts = text.split("=");
  const isParts = text.split(/\s+is\s+/);
  if (equalParts.length > 1 && isParts.length > 1) return null;
  let source: string | undefined;
  let destination: string | undefined;
  if (equalParts.length > 1) {
    if (equalParts.length !== 2) return null;
    [source, destination] = equalParts;
  } else if (isParts.length > 1) {
    if (isParts.length !== 2) return null;
    [source, destination] = isParts;
    destination = destination?.replace(/\s+job$/, "");
  } else {
    return text ? { sourceAlias: null, destinationAlias: text } : null;
  }

  const sourceAlias = normalizeAlias(source ?? "");
  const destinationAlias = normalizeAlias(destination ?? "");
  if (!sourceAlias || !destinationAlias) return null;
  return { sourceAlias, destinationAlias };
}
