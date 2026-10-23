// Money, dates and rates as they appear on client documents. Integer arithmetic only.

/** $1,234.56 from 123456 cents. */
export function dollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** 6.25% from 62500 parts per million. */
export function percent(ppm: number): string {
  const whole = Math.trunc(ppm / 10_000);
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}%`;
}

/** Tax on a subtotal at a rate in parts per million, rounded half-up once. */
export function taxCents(subtotalCents: number, ppm: number): number {
  return Number((BigInt(subtotalCents) * BigInt(ppm) + 500_000n) / 1_000_000n);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** October 22, 2026 from 2026-10-22. */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function monthName(month: number): string {
  return MONTHS[month - 1]!;
}

/** The person's calendar day for an ISO timestamp, in this machine's time zone. */
export function today(nowIso: string): string {
  const d = new Date(nowIso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DAY_MS = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);

export function addDays(date: string, days: number): string {
  return new Date(utc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from a to b; positive when b is later. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

export function termsText(days: number): string {
  return days === 0 ? "Due on receipt" : `Net ${days}`;
}
