import { RESERVED_HANDLES } from "@omnyo/connect-db";

export { RESERVED_HANDLES };

export const HEALTHCHECK_LABEL = "healthcheck";

export const STAGING_LABEL = "stg";

export const RELAY_RESERVED_LABELS: ReadonlySet<string> = new Set([
  "omnyo",
  "omnyohq",
  STAGING_LABEL,
  HEALTHCHECK_LABEL,
  "abuse",
  "apple",
  "billing",
  "download",
  "get",
  "github",
  "google",
  "hostmaster",
  "install",
  "installer",
  "legal",
  "localhost",
  "microsoft",
  "pay",
  "postmaster",
  "privacy",
  "secure",
  "slashnew",
  "terms",
  "update",
  "wallet",
  "webmaster",
  "anthropic",
  "assets",
  "cdn",
  "claude",
  "cloudflare",
  "codex",
  "contact",
  "coolify",
  "cursor",
  "email",
  "hello",
  "hetzner",
  "info",
  "mail",
  "moderator",
  "official",
  "openai",
  "preview",
  "proxy",
  "relay",
  "root",
  "signup",
  "staff",
  "staging",
  "static",
  "system",
  "tunnel",
  "verify",
]);

export const RELAY_LABEL_MIN_LENGTH = 5;

export const RELAY_LABEL_LIMIT_PER_ACCOUNT = 40;

const BRAND_NAMES = ["omnyo", "slashnew", "github"];

const RESERVED_TOKENS = [
  "anthropic",
  "apple",
  "claude",
  "cloudflare",
  "codex",
  "coolify",
  "cursor",
  "github",
  "google",
  "hetzner",
  "microsoft",
  "omnyo",
  "omnyohq",
  "openai",
  "slashnew",
  "binance",
  "coinbase",
  "docusign",
  "facebook",
  "instagram",
  "netflix",
  "paypal",
  "whatsapp",
  "abuse",
  "auth",
  "billing",
  "hostmaster",
  "login",
  "logout",
  "moderator",
  "oauth",
  "official",
  "password",
  "postmaster",
  "security",
  "signin",
  "signout",
  "signup",
  "sso",
  "staff",
  "verify",
  "wallet",
  "webmaster",
];

const VENDOR_NAMES = [
  "anthropic",
  "binance",
  "claude",
  "cloudflare",
  "coinbase",
  "coolify",
  "docusign",
  "facebook",
  "google",
  "hetzner",
  "instagram",
  "microsoft",
  "netflix",
  "openai",
  "paypal",
  "whatsapp",
];

const SIGN_IN_WORDS = [
  "login",
  "logout",
  "signin",
  "signout",
  "password",
  "oauth",
  "verify",
  "appleid",
];

const ORDINARY_WORDS_NEAR_VENDORS = [
  "claudette",
  "claudia",
  "claudine",
  "claudio",
  "claudius",
  "clause",
  "clauses",
  "goggle",
  "goggles",
];

const SKELETON_STEPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-/gu, ""],
  [/0/gu, "o"],
  [/[1i]/gu, "l"],
  [/3/gu, "e"],
  [/4/gu, "a"],
  [/5/gu, "s"],
  [/7/gu, "t"],
  [/rn/gu, "m"],
  [/vv/gu, "w"],
  [/nn/gu, "m"],
  [/cl/gu, "d"],
];

export function labelSkeleton(label: string): string {
  return SKELETON_STEPS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    label.toLowerCase(),
  );
}

const NAME_SKELETONS = [...BRAND_NAMES, ...VENDOR_NAMES].map(labelSkeleton);

const SIGN_IN_SKELETONS = SIGN_IN_WORDS.map(labelSkeleton);

const ORDINARY_WORD_PATTERN = new RegExp(
  [...ORDINARY_WORDS_NEAR_VENDORS]
    .sort((left, right) => right.length - left.length)
    .map(labelSkeleton)
    .join("|"),
  "gu",
);

const GERUND_SIGN = new RegExp(
  `${labelSkeleton("sign")}(?=${labelSkeleton("ing")})`,
  "gu",
);

const RESERVED_TOKEN_SKELETONS: ReadonlySet<string> = new Set(
  RESERVED_TOKENS.map(labelSkeleton),
);

const SHORTEST_BRAND_WITH_DELETION_MATCH = 6;

function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;

  if (Math.abs(left.length - right.length) > 1) return false;

  if (left.length === right.length) {
    const differences: number[] = [];

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) differences.push(index);
    }

    const [first, second] = differences;

    return (
      differences.length === 1 ||
      (differences.length === 2 &&
        first !== undefined &&
        second === first + 1 &&
        left[first] === right[second] &&
        left[second] === right[first])
    );
  }

  const [shorter, longer] =
    left.length < right.length ? [left, right] : [right, left];

  let index = 0;

  while (index < shorter.length && shorter[index] === longer[index]) {
    index += 1;
  }

  return shorter.slice(index) === longer.slice(index + 1);
}

function resemblesBrand(skeleton: string, brand: string): boolean {
  const smallest =
    brand.length >= SHORTEST_BRAND_WITH_DELETION_MATCH
      ? brand.length - 1
      : brand.length;

  for (let size = smallest; size <= brand.length + 1; size += 1) {
    for (let start = 0; start + size <= skeleton.length; start += 1) {
      if (withinOneEdit(skeleton.slice(start, start + size), brand)) {
        return true;
      }
    }
  }

  return false;
}

function hasReservedToken(label: string): boolean {
  const tokens = label.split("-").filter((token) => token !== "");

  for (let start = 0; start < tokens.length; start += 1) {
    let joined = "";

    for (let end = start; end < tokens.length; end += 1) {
      joined += tokens[end];

      if (RESERVED_TOKEN_SKELETONS.has(labelSkeleton(joined))) return true;
    }
  }

  return false;
}

function resemblesVendorOrBrand(skeleton: string): boolean {
  const bare = skeleton.replace(ORDINARY_WORD_PATTERN, "");

  return NAME_SKELETONS.some((name) => resemblesBrand(bare, name));
}

function containsSignInWord(skeleton: string): boolean {
  const bare = skeleton.replace(GERUND_SIGN, "");

  return SIGN_IN_SKELETONS.some((word) => bare.includes(word));
}

export function isRelayReservedLabel(label: string): boolean {
  const normalized = label.toLowerCase();

  return (
    RELAY_RESERVED_LABELS.has(normalized) || RESERVED_HANDLES.has(normalized)
  );
}

export type RelayLabelRule =
  | "reserved"
  | "look-alike"
  | "digits-only"
  | "trailing-hyphen"
  | "too-short";

export function brokenRelayLabelRule(label: string): RelayLabelRule | null {
  const normalized = label.toLowerCase();

  if (isRelayReservedLabel(normalized)) return "reserved";
  const skeleton = labelSkeleton(normalized);

  if (
    hasReservedToken(normalized) ||
    containsSignInWord(skeleton) ||
    resemblesVendorOrBrand(skeleton)
  ) {
    return "look-alike";
  }

  if (!/[a-z]/u.test(normalized)) return "digits-only";

  if (normalized.endsWith("-")) return "trailing-hyphen";

  if (normalized.length < RELAY_LABEL_MIN_LENGTH) return "too-short";

  return null;
}

export type RelayLabelProblem = "reserved" | "invalid-format" | "too-short";

const PROBLEM_FOR_RULE: Readonly<Record<RelayLabelRule, RelayLabelProblem>> = {
  reserved: "reserved",
  "look-alike": "reserved",
  "digits-only": "invalid-format",
  "trailing-hyphen": "invalid-format",
  "too-short": "too-short",
};

export function relayLabelProblem(label: string): RelayLabelProblem | null {
  const rule = brokenRelayLabelRule(label);

  return rule === null ? null : PROBLEM_FOR_RULE[rule];
}

export function isClaimableRelayLabel(label: string): boolean {
  return brokenRelayLabelRule(label) === null;
}

export const RETIRED_LABEL_REFUSAL = "relay label retired";

export const LABEL_LIMIT_REFUSAL = "relay label limit";

export type LabelWriteRefusal = "taken" | "label-limit";

export function labelWriteRefusal(error: unknown): LabelWriteRefusal | null {
  if (!(error instanceof Error)) return null;

  if (error.message.includes(LABEL_LIMIT_REFUSAL)) return "label-limit";

  return /unique constraint/iu.test(error.message) ||
    error.message.includes(RETIRED_LABEL_REFUSAL)
    ? "taken"
    : null;
}

export class RelayLabelLimitError extends Error {
  constructor() {
    super(
      `This account already holds or has released ${RELAY_LABEL_LIMIT_PER_ACCOUNT} addresses`,
    );
    this.name = "RelayLabelLimitError";
  }
}
