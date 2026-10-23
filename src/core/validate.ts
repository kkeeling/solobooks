import { Refusal } from "./refusal.ts";

/** Largest single amount solobooks accepts: $10 billion, so sums stay exact integers. */
export const MAX_CENTS = 1_000_000_000_000;

export type Field =
  | { type: "text"; required?: boolean; description: string }
  | { type: "int"; required?: boolean; min?: number; max?: number; unit?: string; description: string }
  | { type: "date"; required?: boolean; description: string }
  | { type: "enum"; required?: boolean; values: readonly string[]; description: string }
  | { type: "list"; required?: boolean; minItems?: number; of: Fields; description: string }
  | { type: "set"; required?: boolean; values: readonly string[]; description: string };

export type Fields = Record<string, Field>;

const CURRENCY_REASON = "solobooks keeps books in US dollars only, so currency must be USD.";

/** An optional currency field: present only so a non-USD amount is refused instead of misread. */
export const currency: Field = { type: "enum", values: ["USD"], description: "Optional; only USD is accepted." };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Checks input against its field list, returning only known fields. Throws a Refusal on the first problem. */
export function validate(input: unknown, fields: Fields, prefix = ""): Record<string, any> {
  if (!isPlainObject(input)) throw new Refusal("The input must be a JSON object.", prefix || "input");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(fields, key)) {
      const known = Object.keys(fields).join(", ") || "none";
      throw new Refusal(`This field isn't one solobooks knows here; the known fields are ${known}.`, prefix + key);
    }
  }
  const out: Record<string, any> = {};
  for (const [key, f] of Object.entries(fields)) {
    const name = prefix + key;
    const v = input[key];
    if (v === undefined || v === null) {
      if (f.required) throw new Refusal(`${name} is required.`, name);
      continue;
    }
    switch (f.type) {
      case "text":
        if (typeof v !== "string" || !v.trim()) throw new Refusal(`${name} must be non-empty text.`, name);
        out[key] = v.trim();
        break;
      case "int": {
        if (typeof v !== "number" || !Number.isSafeInteger(v)) {
          const unit = f.unit ? ` of ${f.unit}` : "";
          throw new Refusal(`${name} must be a whole number${unit}.`, name);
        }
        if (f.min !== undefined && v < f.min) throw new Refusal(`${name} must be at least ${f.min}.`, name);
        if (f.max !== undefined && v > f.max) throw new Refusal(`${name} must be at most ${f.max}.`, name);
        out[key] = v;
        break;
      }
      case "date":
        if (typeof v !== "string" || !validDate(v)) throw new Refusal(`${name} must be a calendar date written YYYY-MM-DD.`, name);
        out[key] = v;
        break;
      case "enum":
        if (typeof v !== "string" || !f.values.includes(v)) {
          if (key === "currency") throw new Refusal(CURRENCY_REASON, name);
          throw new Refusal(`${name} must be one of ${f.values.join(", ")}.`, name);
        }
        out[key] = v;
        break;
      case "set": {
        const ok = Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && f.values.includes(x));
        if (!ok || new Set(v).size !== v.length) {
          throw new Refusal(`${name} must be a list of one or more of ${f.values.join(", ")}, each once.`, name);
        }
        out[key] = f.values.filter((x) => v.includes(x)); // one canonical order
        break;
      }
      case "list": {
        if (!Array.isArray(v)) throw new Refusal(`${name} must be a list.`, name);
        if (f.minItems !== undefined && v.length < f.minItems) {
          throw new Refusal(`${name} needs at least ${f.minItems} items.`, name);
        }
        out[key] = v.map((item, i) => validate(item, f.of, `${name}[${i}].`));
        break;
      }
    }
  }
  return out;
}

/** CLI flags arrive as text; turn the ones a field declares as whole numbers into numbers. */
export function coerceFlags(flags: Record<string, string>, fields: Fields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    const t = fields[k]?.type;
    out[k] = t === "int" && /^-?\d+$/.test(v) ? Number(v) : t === "set" ? v.split(",").map((x) => x.trim()) : v;
  }
  return out;
}
