/** Minutes a client is billed for: their minimum first, then rounded up to their increment. */
export function billableMinutes(minutes: number, incrementMinutes: number, minimumMinutes: number): number {
  const atLeast = Math.max(minutes, minimumMinutes);
  return Math.ceil(atLeast / incrementMinutes) * incrementMinutes;
}

/** Cents for a time line, rounded half-up once. Integer arithmetic only. */
export function lineAmountCents(minutes: number, rateCentsPerHour: number): number {
  const n = minutes * rateCentsPerHour + 30;
  if (!Number.isSafeInteger(n)) throw new Error("time line amount is too large to compute exactly");
  return (n - (n % 60)) / 60;
}
