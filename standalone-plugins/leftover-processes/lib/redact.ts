const SECRET_NAME =
  "(?:[a-z][\\w-]*[_-])?(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credential|authorization)";

const QUOTED_OR_BARE_VALUE = "(?:\"[^\"\\n]*\"|'[^'\\n]*'|[^\\s,;]+)";

const BEARER = /(\b(?:authorization\s*[:=]\s*)?(?:bearer|basic)\s+)[^\s"',;]+/gi;

const NAMED_ASSIGNMENT = new RegExp(
  `(?<![\\w-])(${SECRET_NAME}["']?\\s*[=:]\\s*)${QUOTED_OR_BARE_VALUE}`,
  "gi",
);

const NAMED_FLAG = new RegExp(`(--?${SECRET_NAME}(?:\\s+|=))${QUOTED_OR_BARE_VALUE}`, "gi");

const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

const PREFIXED_TOKEN =
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat)[-_][A-Za-z0-9_-]{8,}|\bA(?:KIA|SIA)[0-9A-Z]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;

const LONG_HEX = /\b[A-Fa-f0-9]{32,}\b/g;

const LONG_OPAQUE = /[A-Za-z0-9+_=-]{40,}/g;

function hideOpaque(token: string): string {
  return /\d/.test(token) && /[A-Za-z]/.test(token) ? "<redacted>" : token;
}

export function redact(text: string): string {
  return text
    .replace(BEARER, "$1<redacted>")
    .replace(NAMED_FLAG, "$1<redacted>")
    .replace(NAMED_ASSIGNMENT, "$1<redacted>")
    .replace(URL_CREDENTIAL, "$1<redacted>@")
    .replace(PREFIXED_TOKEN, "<redacted>")
    .replace(LONG_HEX, "<redacted>")
    .replace(LONG_OPAQUE, hideOpaque);
}
