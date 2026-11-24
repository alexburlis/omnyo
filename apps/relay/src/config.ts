import { isIP } from "node:net";
import { z } from "zod";

export const CLIENT_IP_SOURCES = ["proxy-protocol", "xff-rightmost"] as const;

export type ClientIpSourceMode = (typeof CLIENT_IP_SOURCES)[number];

export const DEFAULT_USER_EGRESS_GB_PER_MONTH = 100;

export const DEFAULT_MAX_BUFFERED_MB = 192;

export const DEFAULT_INSTALLER_MB_PER_LABEL_PER_DAY = 200;

export const DEFAULT_PREVIEW_MB_PER_LABEL_PER_DAY = 1024;

const BYTES_PER_GB = 1_000_000_000;

const BYTES_PER_MB = 1024 * 1024;

const MIN_AUTH_SECRET_LENGTH = 32;

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const GITHUB_USER_ID = /^[1-9][0-9]{0,19}$/u;

const UNRESOLVED_REFERENCE_PREFIX = "op://";

const TAILNET_IPV4_FIRST_OCTET = 100;

const TAILNET_IPV4_SECOND_OCTET_MIN = 64;

const TAILNET_IPV4_SECOND_OCTET_MAX = 127;

export const RESERVED_TEST_TLDS = [
  "test",
  "example",
  "invalid",
  "localhost",
] as const;

export function isReservedTestDomain(hostname: string): boolean {
  const name = hostname.toLowerCase();

  return RESERVED_TEST_TLDS.some(
    (tld) => name === tld || name.endsWith(`.${tld}`),
  );
}

const PROXY_PROTOCOL_ONLY = [
  "RELAY_PROXY_CIDR",
  "ACME_DIRECTORY_URL",
  "ACME_ACCOUNT_EMAIL",
  "CLOUDFLARE_DNS_TOKEN",
  "CLOUDFLARE_ZONE_ID",
] as const;

export interface Cidr {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

export interface AcmeConfig {
  directoryUrl: string;
  accountEmail?: string;
  cloudflareDnsToken: string;
  cloudflareZoneId: string;
}

export type EdgeConfig =
  | { clientIpSource: "proxy-protocol"; proxyCidr: Cidr; acme: AcmeConfig }
  | { clientIpSource: "xff-rightmost" };

export const SIGN_UP_MODES = ["allowlist", "open"] as const;

export type SignUpMode = (typeof SIGN_UP_MODES)[number];

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  openSignUp?: true;
  allowedUserIds?: readonly string[];
}

export interface RelayConfig {
  baseDomain: string;
  appUrl: string;
  betterAuthSecret: string;
  github: GitHubConfig;
  databasePath: string;
  port: number;
  healthPort: number;
  edge: EdgeConfig;
  userEgressBytesPerMonth: number;
  maxBufferedBytes: number;
  installerBytesPerLabelPerDay: number;
  previewBytesPerLabelPerDay: number;
  backupPushUrl: string | null;
  securityContact: string;
}

export class RelayConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid relay configuration:\n- ${problems.join("\n- ")}`);
    this.name = "RelayConfigError";
    this.problems = problems;
  }
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

const requiredText = z
  .string({ error: "is required" })
  .trim()
  .min(1, { error: "is required" });

const baseDomain = requiredText
  .transform((value) => value.toLowerCase())
  .refine(
    (value) =>
      value.length <= 253 &&
      value.includes(".") &&
      value.split(".").every((label) => HOSTNAME_LABEL.test(label)),
    { error: "must be a lowercase DNS name such as relay.example" },
  );

const SECURITY_CONTACT = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u;

const securityContact = z
  .string()
  .trim()
  .optional()
  .transform((value) =>
    value === undefined || value === "" ? null : value.toLowerCase(),
  )
  .refine((value) => value === null || SECURITY_CONTACT.test(value), {
    error: "must be an email address such as abuse@relay.example",
  });

const port = requiredText
  .transform(Number)
  .pipe(
    z
      .number({ error: "must be an integer port" })
      .int({ error: "must be an integer port" })
      .min(0, { error: "must be between 0 and 65535" })
      .max(65535, { error: "must be between 0 and 65535" }),
  );

function positiveNumber(defaultValue: number) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      value === undefined || value === "" ? defaultValue : Number(value),
    )
    .pipe(
      z
        .number({ error: "must be a positive number" })
        .positive({ error: "must be a positive number" }),
    );
}

const httpsUrl = requiredText.refine(
  (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  },
  { error: "must be an https URL" },
);

const cloudflareZoneId = requiredText.regex(/^[0-9a-f]{32}$/u, {
  error: "must be a 32-character lowercase hexadecimal Cloudflare zone id",
});

const optionalEmail = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value))
  .pipe(z.email({ error: "must be an email address" }).nullable());

function isTailnetIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split(".").map(Number);

  return (
    first === TAILNET_IPV4_FIRST_OCTET &&
    second !== undefined &&
    second >= TAILNET_IPV4_SECOND_OCTET_MIN &&
    second <= TAILNET_IPV4_SECOND_OCTET_MAX
  );
}

function isBackupPushUrl(value: string): boolean {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isTailnetIpv4(url.hostname))
  );
}

const backupPushUrl = z
  .string()
  .trim()
  .optional()
  .transform((value, context) => {
    if (value === undefined || value === "") return null;

    if (!isBackupPushUrl(value)) {
      context.addIssue({
        code: "custom",
        message:
          "must be an https URL, or an http URL on a 100.64.0.0/10 tailnet IPv4 address",
      });

      return z.NEVER;
    }

    return value;
  });

function parseCidr(value: string): Cidr | null {
  const slash = value.indexOf("/");

  if (slash === -1 || slash !== value.lastIndexOf("/")) return null;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);

  if (!/^\d{1,3}$/u.test(prefixText)) return null;
  const prefix = Number(prefixText);
  const version = isIP(address);

  if (version === 4 && prefix <= 32) return { address, prefix, family: "ipv4" };

  if (version === 6 && prefix <= 128)
    return { address, prefix, family: "ipv6" };

  return null;
}

const cidr = requiredText.transform((value, context) => {
  const parsed = parseCidr(value);

  if (parsed === null) {
    context.addIssue({
      code: "custom",
      message: "must be an IPv4 or IPv6 CIDR such as 10.0.1.0/24",
    });

    return z.NEVER;
  }

  return parsed;
});

const sharedSchema = z.object({
  BASE_DOMAIN: baseDomain,
  APP_URL: requiredText,
  BETTER_AUTH_SECRET: requiredText.min(MIN_AUTH_SECRET_LENGTH, {
    error: `must be at least ${MIN_AUTH_SECRET_LENGTH} characters`,
  }),
  GITHUB_CLIENT_ID: requiredText,
  GITHUB_CLIENT_SECRET: requiredText,
  DATABASE_PATH: requiredText,
  PORT: port,
  HEALTH_PORT: port,
  RELAY_SIGNUP: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === undefined || value === "" ? null : value))
    .pipe(
      z
        .enum(SIGN_UP_MODES, {
          error: `must be one of ${SIGN_UP_MODES.join(", ")}`,
        })
        .nullable(),
    ),
  RELAY_CLIENT_IP_SOURCE: z.enum(CLIENT_IP_SOURCES, {
    error: `must be one of ${CLIENT_IP_SOURCES.join(", ")}`,
  }),
  RELAY_USER_EGRESS_GB_PER_MONTH: positiveNumber(
    DEFAULT_USER_EGRESS_GB_PER_MONTH,
  ),
  RELAY_MAX_BUFFERED_MB: positiveNumber(DEFAULT_MAX_BUFFERED_MB),
  RELAY_INSTALLER_MB_PER_LABEL_PER_DAY: positiveNumber(
    DEFAULT_INSTALLER_MB_PER_LABEL_PER_DAY,
  ),
  RELAY_PREVIEW_MB_PER_LABEL_PER_DAY: positiveNumber(
    DEFAULT_PREVIEW_MB_PER_LABEL_PER_DAY,
  ),
  RELAY_ALLOWED_GITHUB_IDS: z
    .string()
    .trim()
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === "") return null;
      const ids = value.split(",").map((entry) => entry.trim());

      if (!ids.every((id) => GITHUB_USER_ID.test(id))) {
        context.addIssue({
          code: "custom",
          message: "must list numeric GitHub user IDs separated by commas",
        });

        return z.NEVER;
      }

      return [...new Set(ids)];
    }),
  RELAY_BACKUP_PUSH_URL: backupPushUrl,
  RELAY_SECURITY_CONTACT: securityContact,
});

const proxyProtocolSchema = z.object({
  RELAY_PROXY_CIDR: cidr,
  ACME_DIRECTORY_URL: httpsUrl,
  ACME_ACCOUNT_EMAIL: optionalEmail,
  CLOUDFLARE_DNS_TOKEN: requiredText,
  CLOUDFLARE_ZONE_ID: cloudflareZoneId,
});

const READ_VARIABLES = [
  ...Object.keys(sharedSchema.shape),
  ...PROXY_PROTOCOL_ONLY,
];

function unresolvedReferences(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return READ_VARIABLES.filter(
    (name) =>
      env[name]?.trim().startsWith(UNRESOLVED_REFERENCE_PREFIX) === true,
  );
}

function problemsFrom(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.map(String).join(".") || "environment";

    return `${name} ${issue.message}`;
  });
}

function appUrlProblems(appUrl: string, domain: string): string[] {
  let url: URL;

  try {
    url = new URL(appUrl);
  } catch {
    return ["APP_URL must be an absolute URL"];
  }

  const problems: string[] = [];
  const local = isLocalDevelopmentHost(url.hostname);

  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    problems.push(
      "APP_URL must use https (http is allowed only for *.localhost)",
    );
  }

  if (url.username !== "" || url.password !== "") {
    problems.push("APP_URL must not contain credentials");
  }

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    problems.push(
      "APP_URL must be an origin without a path, query or fragment",
    );
  }

  if (url.hostname !== domain) {
    problems.push("APP_URL host must equal BASE_DOMAIN");
  }

  if (url.port !== "" && !local) {
    problems.push("APP_URL must not name a port outside *.localhost");
  }

  return problems;
}

export function reservedTestDomainList(): string {
  const names = RESERVED_TEST_TLDS.map((tld) => `.${tld}`);

  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function isPresent(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

export function parseRelayConfig(
  env: Readonly<Record<string, string | undefined>>,
): RelayConfig {
  const references = unresolvedReferences(env);
  const problems: string[] = [];

  function configError(): RelayConfigError {
    return new RelayConfigError([
      ...references.map(
        (name) =>
          `${name} is an unresolved ${UNRESOLVED_REFERENCE_PREFIX} reference`,
      ),
      ...problems.filter(
        (problem) => !references.some((name) => problem.startsWith(`${name} `)),
      ),
    ]);
  }

  const shared = sharedSchema.safeParse(env);

  if (!shared.success) {
    problems.push(...problemsFrom(shared.error));
    throw configError();
  }

  const values = shared.data;
  problems.push(...appUrlProblems(values.APP_URL, values.BASE_DOMAIN));

  const signUp: SignUpMode = values.RELAY_SIGNUP ?? "allowlist";

  if (signUp === "open" && values.RELAY_ALLOWED_GITHUB_IDS !== null) {
    problems.push(
      "RELAY_ALLOWED_GITHUB_IDS must be empty when RELAY_SIGNUP is open",
    );
  }

  if (
    signUp === "allowlist" &&
    values.RELAY_ALLOWED_GITHUB_IDS === null &&
    !isReservedTestDomain(values.BASE_DOMAIN)
  ) {
    problems.push(
      `RELAY_ALLOWED_GITHUB_IDS is required outside the reserved test domains ${reservedTestDomainList()}, unless RELAY_SIGNUP is open`,
    );
  }

  let edge: EdgeConfig | null = null;

  if (values.RELAY_CLIENT_IP_SOURCE === "proxy-protocol") {
    const proxy = proxyProtocolSchema.safeParse(env);

    if (proxy.success) {
      edge = {
        clientIpSource: "proxy-protocol",
        proxyCidr: proxy.data.RELAY_PROXY_CIDR,
        acme: {
          directoryUrl: proxy.data.ACME_DIRECTORY_URL,
          ...(proxy.data.ACME_ACCOUNT_EMAIL === null
            ? {}
            : { accountEmail: proxy.data.ACME_ACCOUNT_EMAIL }),
          cloudflareDnsToken: proxy.data.CLOUDFLARE_DNS_TOKEN,
          cloudflareZoneId: proxy.data.CLOUDFLARE_ZONE_ID,
        },
      };
    } else {
      problems.push(...problemsFrom(proxy.error));
    }
  } else {
    if (!isReservedTestDomain(values.BASE_DOMAIN)) {
      problems.push(
        `RELAY_CLIENT_IP_SOURCE=xff-rightmost is allowed only on the reserved test domains ${reservedTestDomainList()}; use proxy-protocol`,
      );
    }

    for (const name of PROXY_PROTOCOL_ONLY) {
      if (isPresent(env[name])) {
        problems.push(
          `${name} is valid only with RELAY_CLIENT_IP_SOURCE=proxy-protocol`,
        );
      }
    }

    edge = { clientIpSource: "xff-rightmost" };
  }

  if (problems.length > 0 || references.length > 0 || edge === null)
    throw configError();

  return {
    baseDomain: values.BASE_DOMAIN,
    appUrl: new URL(values.APP_URL).origin,
    betterAuthSecret: values.BETTER_AUTH_SECRET,
    github: {
      clientId: values.GITHUB_CLIENT_ID,
      clientSecret: values.GITHUB_CLIENT_SECRET,
      ...(signUp === "open" ? { openSignUp: true as const } : {}),
      ...(values.RELAY_ALLOWED_GITHUB_IDS === null
        ? {}
        : { allowedUserIds: values.RELAY_ALLOWED_GITHUB_IDS }),
    },
    databasePath: values.DATABASE_PATH,
    port: values.PORT,
    healthPort: values.HEALTH_PORT,
    edge,
    userEgressBytesPerMonth: Math.floor(
      values.RELAY_USER_EGRESS_GB_PER_MONTH * BYTES_PER_GB,
    ),
    maxBufferedBytes: Math.floor(values.RELAY_MAX_BUFFERED_MB * BYTES_PER_MB),
    installerBytesPerLabelPerDay: Math.floor(
      values.RELAY_INSTALLER_MB_PER_LABEL_PER_DAY * BYTES_PER_MB,
    ),
    previewBytesPerLabelPerDay: Math.floor(
      values.RELAY_PREVIEW_MB_PER_LABEL_PER_DAY * BYTES_PER_MB,
    ),
    backupPushUrl: values.RELAY_BACKUP_PUSH_URL,
    securityContact:
      values.RELAY_SECURITY_CONTACT ?? `abuse@${values.BASE_DOMAIN}`,
  };
}
