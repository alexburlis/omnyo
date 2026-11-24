import type { ThreadEvent } from "./provider-event.js";

export const CREDENTIAL_REDACTION_MARKER = "[REDACTED]";

const INVALID_JSON_REDACTION_MARKER =
  "[Content withheld: this text could not be safely displayed]";

export interface CredentialRedactionOptions {
  invalidJsonText?: "throw" | "withhold";
}

const MAX_STRING_CHARS = 16 * 1024 * 1024;

const MAX_NODES = 100_000;

const MAX_DEPTH = 64;

const MAX_KNOWN_VALUES = 1024;

const MAX_KNOWN_VALUE_CHARS = 1024 * 1024;

export class CredentialRedactionError extends Error {
  constructor() {
    super("Credential redaction failed; content withheld");
    this.name = "CredentialRedactionError";
  }
}

const CREDENTIAL_FIELD_CACHE_LIMIT = 4096;

const credentialFieldNames = new Map<string, boolean>();

const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]* )?PRIVATE KEY-----|$)/g;

const PROVIDER_TOKEN_PATTERN =
  /\boseo_[A-Za-z0-9._-]{11,}|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|(?:bb|omnyo)(?:de|cm|cred|dh)_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

const BEARER_PATTERN = /\bBearer[ \t]+[^\s"',;<>]+/gi;

const POSSIBLE_SECRET_PATTERN =
  /-----BEGIN |oseo_|sk-|gh[pousr]_|github_pat_|xox[baprs]-|(?:bb|omnyo)(?:de|cm|cred|dh)_|AKIA|eyJ|bearer/i;

const POSSIBLE_CREDENTIAL_LABEL_PATTERN =
  /pass(?:word|wd)|secret|token|key|authorization|credential|cookie/i;

const JSON_TEXT_PATTERN =
  /^\s*(?:\{\s*(?:"|\}|$)|\[\s*(?:"|\{|\[|\]|-?\d|true\b|false\b|null\b|$))/;

const knownValuePatterns = new WeakMap<readonly string[], RegExp | undefined>();

export function isCredentialField(name: string): boolean {
  const cached = credentialFieldNames.get(name);

  if (cached !== undefined) return cached;

  const result = classifyCredentialField(name);

  if (credentialFieldNames.size >= CREDENTIAL_FIELD_CACHE_LIMIT)
    credentialFieldNames.clear();
  credentialFieldNames.set(name, result);

  return result;
}

function classifyCredentialField(name: string): boolean {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();

  if (/^(?:NEXT_PUBLIC_|PUBLIC_|VITE_)/.test(normalized)) return false;

  return /(?:^|_)(?:PASSWORDS?|PASSWDS?|SECRETS?|TOKENS?|API_KEYS?|AUTHORIZATION|ACCESS_KEYS?|PRIVATE_KEYS?|CREDENTIALS?|COOKIES?)(?:_|$)/.test(
    normalized,
  );
}

function redactCredentialLabels(text: string): string {
  if (!text.includes(":") && !text.includes("=")) return text;

  if (!POSSIBLE_CREDENTIAL_LABEL_PATTERN.test(text)) return text;

  const parts: string[] = [];
  let cursor = 0;

  for (const match of text.matchAll(
    /(?<![\w.-])(["']?([\w.-]+)["']?[ \t]*[:=][ \t]*)/g,
  )) {
    const name = match[2]?.replace(/^[^A-Za-z]+/, "");
    const start = match.index + match[0].length;

    if (name === undefined || !isCredentialField(name) || start < cursor)
      continue;

    const value = /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;{}]+)/.exec(
      text.slice(start),
    )?.[0];

    if (value === undefined) continue;

    const quote = value.startsWith('"')
      ? '"'
      : value.startsWith("'")
        ? "'"
        : "";

    parts.push(
      text.slice(cursor, start),
      `${quote}${CREDENTIAL_REDACTION_MARKER}${quote}`,
    );
    cursor = start + value.length;
  }

  parts.push(text.slice(cursor));

  return parts.join("");
}

function compileKnownValuePattern(
  knownValues: readonly string[],
): RegExp | undefined {
  const reusable = Object.isFrozen(knownValues);

  if (reusable && knownValuePatterns.has(knownValues))
    return knownValuePatterns.get(knownValues);

  const values = [...new Set(knownValues.filter((value) => value.length > 0))];

  if (
    values.length > MAX_KNOWN_VALUES ||
    values.reduce((total, value) => total + value.length, 0) >
      MAX_KNOWN_VALUE_CHARS
  )
    throw new CredentialRedactionError();

  const pattern =
    values.length === 0
      ? undefined
      : new RegExp(
          values
            .sort((left, right) => right.length - left.length)
            .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("|"),
          "g",
        );

  if (reusable) knownValuePatterns.set(knownValues, pattern);

  return pattern;
}

function createCredentialRedactor(
  knownValues: readonly string[],
  options: CredentialRedactionOptions = {},
) {
  const exactPattern = compileKnownValuePattern(knownValues);
  let stringChars = 0;

  const redactPlainText = (text: string): string => {
    stringChars += text.length;

    if (stringChars > MAX_STRING_CHARS) throw new CredentialRedactionError();

    let result =
      exactPattern === undefined
        ? text
        : text.replace(exactPattern, CREDENTIAL_REDACTION_MARKER);

    if (POSSIBLE_SECRET_PATTERN.test(result))
      result = result
        .replace(PRIVATE_KEY_PATTERN, CREDENTIAL_REDACTION_MARKER)
        .replace(PROVIDER_TOKEN_PATTERN, CREDENTIAL_REDACTION_MARKER)
        .replace(JWT_PATTERN, CREDENTIAL_REDACTION_MARKER)
        .replace(BEARER_PATTERN, `Bearer ${CREDENTIAL_REDACTION_MARKER}`);

    return redactCredentialLabels(result);
  };

  let nodes = 0;

  const visit = (
    current: object,
    depth: number,
    credentialContext: boolean,
  ): object => {
    if (depth > MAX_DEPTH) throw new CredentialRedactionError();
    let copy: object | null = null;

    for (const [key, child] of Object.entries(current)) {
      nodes += 1;

      if (nodes > MAX_NODES) throw new CredentialRedactionError();
      const sensitive = credentialContext || isCredentialField(key);
      let next: unknown = child;

      if (typeof child === "string") {
        const sanitized = redactText(child, depth + 1);
        next = sensitive ? CREDENTIAL_REDACTION_MARKER : sanitized;
      } else if (child !== null && typeof child === "object") {
        next = visit(child, depth + 1, sensitive);
      }

      if (next === child) continue;
      copy ??= Array.isArray(current) ? [...current] : { ...current };
      Reflect.set(copy, key, next);
    }

    return copy ?? current;
  };

  const redactText = (text: string, depth: number): string => {
    const plain = redactPlainText(text);

    if (!JSON_TEXT_PATTERN.test(text)) return plain;
    let decoded: unknown;

    try {
      decoded = JSON.parse(text);
    } catch (error) {
      if (
        options.invalidJsonText === "withhold" &&
        error instanceof SyntaxError
      )
        return INVALID_JSON_REDACTION_MARKER;
      throw new CredentialRedactionError();
    }

    if (decoded === null || typeof decoded !== "object")
      throw new CredentialRedactionError();

    const redacted = visit(decoded, depth, false);

    return redacted === decoded ? text : JSON.stringify(redacted);
  };

  return {
    redactText: (text: string) => redactText(text, 0),
    redactPayload<T extends object>(value: T): T {
      return visit(value, 0, false) as T;
    },
  };
}

export function createCredentialTextRedactor(
  knownValues: readonly string[],
): (text: string) => string {
  return createCredentialRedactor(knownValues).redactText;
}

export function redactCredentialText(
  text: string,
  knownValues: readonly string[] = [],
): string {
  return createCredentialTextRedactor(knownValues)(text);
}

export function redactCredentialPayload<T extends object>(
  value: T,
  knownValues: readonly string[] = [],
  options: CredentialRedactionOptions = {},
): T {
  return createCredentialRedactor(knownValues, options).redactPayload(value);
}

export function maskProviderEnvironmentEvent(event: ThreadEvent): ThreadEvent {
  if (event.type !== "provider.env-resolved") return event;

  const values = event.entries.flatMap((entry) =>
    typeof entry.value === "string" ? [entry.value] : [],
  );

  return {
    ...event,
    entries: event.entries.map((entry): (typeof event.entries)[number] => ({
      ...entry,
      value: { masked: true },
      ...(entry.reason === undefined
        ? {}
        : { reason: redactCredentialText(entry.reason, values) }),
    })),
  };
}
