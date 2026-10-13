/** Convert a confirmed dollar rate without inventing a rate for a blank field. */
export function parseHourlyRateCents(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const match = /^(?:(\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/.exec(text);
  if (!match) throw new Error("Enter a nonnegative hourly rate with at most two decimal places.");
  const cents = Number(match[1] ?? "0") * 100 + Number((match[2] ?? match[3] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) throw new Error("This hourly rate is too large.");
  return cents;
}
