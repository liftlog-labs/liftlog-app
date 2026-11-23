/** Pounds stored as integer hundredths so 45.5 + 45 stays exact. */
export function parsePounds(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

export function formatPounds(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  if (frac === 0) return String(whole);
  if (frac % 10 === 0) return `${whole}.${frac / 10}`;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

export function addPounds(left: string, right: string): string | null {
  const a = parsePounds(left);
  const b = parsePounds(right);
  if (a === null || b === null) return null;
  return formatPounds(a + b);
}
