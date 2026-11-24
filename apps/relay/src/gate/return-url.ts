export const MAX_RETURN_LENGTH = 4096;

const MAX_DECODE_ROUNDS = 3;

const UNICODE_SPACES: ReadonlySet<number> = new Set([
  0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

function isForbiddenCodePoint(code: number): boolean {
  return (
    code <= 0x20 ||
    code === 0x7f ||
    code === 0x5c ||
    (code >= 0x2000 && code <= 0x200a) ||
    UNICODE_SPACES.has(code)
  );
}

function hasForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    if (isForbiddenCodePoint(character.codePointAt(0) ?? 0)) return true;
  }

  return false;
}

function decodeRound(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function validateReturn(raw: string, origin: string): string | null {
  if (raw.length === 0 || raw.length > MAX_RETURN_LENGTH) return null;

  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let form = raw;

  for (let round = 0; round <= MAX_DECODE_ROUNDS; round += 1) {
    if (hasForbiddenCharacter(form)) return null;
    const next = decodeRound(form);

    if (next === null) return null;

    if (next === form) break;

    if (round === MAX_DECODE_ROUNDS) return null;
    form = next;
  }

  let resolved: URL;

  try {
    resolved = new URL(raw, origin);
  } catch {
    return null;
  }

  if (resolved.origin !== origin) return null;

  return `${resolved.pathname}${resolved.search}`;
}
