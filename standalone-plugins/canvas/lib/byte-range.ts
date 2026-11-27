export function byteRange(header: string | undefined, total: number) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header ?? "");

  if (match === null || (match[1] === "" && match[2] === "")) return null;

  const first = match[1] ?? "";
  const last = match[2] ?? "";
  const start = first === "" ? Math.max(0, total - Number(last)) : Number(first);
  const end = first === "" || last === "" ? total - 1 : Math.min(Number(last), total - 1);

  return start > end || start >= total ? "unsatisfiable" : { start, end };
}
