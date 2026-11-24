export const WEEKLY_FACT_TARGET = 7;

export function productFactLines(value: string | number | boolean | undefined) {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^\d+\.\s+/, ""))
    .filter(Boolean);
}
