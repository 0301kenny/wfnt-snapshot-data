export function parseNumericFlag(value, fallback) {
  if (value === undefined) return fallback;
  return typeof value === 'string' ? Number(value) : Number.NaN;
}
