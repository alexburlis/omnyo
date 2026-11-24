import { describe, expect, it } from "vitest";
import { parseRelayConfig, RelayConfigError } from "./config.js";

const xffEnv = {
  BASE_DOMAIN: "relay.example",
  APP_URL: "https://relay.example",
  BETTER_AUTH_SECRET: "a".repeat(32),
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-value",
  DATABASE_PATH: "/data/relay.sqlite",
  PORT: "8443",
  HEALTH_PORT: "8080",
  RELAY_CLIENT_IP_SOURCE: "xff-rightmost",
};

const proxyEnv = {
  ...xffEnv,
  RELAY_CLIENT_IP_SOURCE: "proxy-protocol",
  RELAY_PROXY_CIDR: "10.0.1.0/24",
  ACME_DIRECTORY_URL: "https://acme-staging-v02.api.letsencrypt.org/directory",
  ACME_ACCOUNT_EMAIL: "ops@relay.example",
  CLOUDFLARE_DNS_TOKEN: "dns-value",
  CLOUDFLARE_ZONE_ID: "0123456789abcdef0123456789abcdef",
};

function problems(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseRelayConfig(env);
  } catch (error) {
    if (error instanceof RelayConfigError) return error.problems;
    throw error;
  }

  throw new Error("expected a configuration error");
}

describe("parseRelayConfig", () => {
  it("parses option R with the documented defaults", () => {
    const config = parseRelayConfig(xffEnv);
    expect(config.edge).toEqual({ clientIpSource: "xff-rightmost" });
    expect(config.appUrl).toBe("https://relay.example");
    expect(config.userEgressBytesPerMonth).toBe(100_000_000_000);
    expect(config.maxBufferedBytes).toBe(192 * 1024 * 1024);
    expect(config.installerBytesPerLabelPerDay).toBe(200 * 1024 * 1024);
    expect(config.previewBytesPerLabelPerDay).toBe(1024 * 1024 * 1024);
    expect(config.port).toBe(8443);
    expect(config.healthPort).toBe(8080);
    expect(config.backupPushUrl).toBeNull();
    expect(config.securityContact).toBe("abuse@relay.example");
  });

  it("parses option P with its proxy network and ACME settings", () => {
    const config = parseRelayConfig({
      ...proxyEnv,
      RELAY_USER_EGRESS_GB_PER_MONTH: "2",
      RELAY_PREVIEW_MB_PER_LABEL_PER_DAY: "64",
    });

    expect(config.edge).toEqual({
      clientIpSource: "proxy-protocol",
      proxyCidr: { address: "10.0.1.0", prefix: 24, family: "ipv4" },
      acme: {
        directoryUrl: proxyEnv.ACME_DIRECTORY_URL,
        accountEmail: proxyEnv.ACME_ACCOUNT_EMAIL,
        cloudflareDnsToken: proxyEnv.CLOUDFLARE_DNS_TOKEN,
        cloudflareZoneId: proxyEnv.CLOUDFLARE_ZONE_ID,
      },
    });
    expect(config.userEgressBytesPerMonth).toBe(2_000_000_000);
    expect(config.previewBytesPerLabelPerDay).toBe(64 * 1024 * 1024);
  });

  it("allows xff-rightmost client addresses only on reserved test domains", () => {
    for (const domain of ["relay.test", "relay.example", "omnyo.localhost"]) {
      const appUrl = domain.endsWith(".localhost")
        ? `http://${domain}:8787`
        : `https://${domain}`;

      expect(
        parseRelayConfig({ ...xffEnv, BASE_DOMAIN: domain, APP_URL: appUrl })
          .edge,
        domain,
      ).toEqual({ clientIpSource: "xff-rightmost" });
    }

    for (const domain of ["omnyo.link", "stg.omnyo.link"]) {
      expect(
        problems({
          ...xffEnv,
          BASE_DOMAIN: domain,
          APP_URL: `https://${domain}`,
          RELAY_ALLOWED_GITHUB_IDS: "1",
        }),
        domain,
      ).toEqual([
        "RELAY_CLIENT_IP_SOURCE=xff-rightmost is allowed only on the reserved test domains .test, .example, .invalid and .localhost; use proxy-protocol",
      ]);
    }
  });

  it("registers the ACME account without a contact when no email is set", () => {
    for (const accountEmail of [undefined, "", "  "]) {
      const { edge } = parseRelayConfig({
        ...proxyEnv,
        ACME_ACCOUNT_EMAIL: accountEmail,
      });

      if (edge.clientIpSource !== "proxy-protocol") {
        throw new Error("expected option P");
      }

      expect(edge.acme).not.toHaveProperty("accountEmail");
    }

    expect(
      problems({ ...proxyEnv, ACME_ACCOUNT_EMAIL: "not-an-address" }),
    ).toEqual(["ACME_ACCOUNT_EMAIL must be an email address"]);
  });

  it("refuses unresolved op:// references by name without echoing them", () => {
    const reference = "op://Example/relay-item/field";

    const found = problems({
      ...proxyEnv,
      APP_URL: ` ${reference}`,
      GITHUB_CLIENT_SECRET: reference,
      CLOUDFLARE_DNS_TOKEN: reference,
      RELAY_BACKUP_PUSH_URL: reference,
      PORT: "70000",
    });

    expect(found).toEqual([
      "APP_URL is an unresolved op:// reference",
      "GITHUB_CLIENT_SECRET is an unresolved op:// reference",
      "RELAY_BACKUP_PUSH_URL is an unresolved op:// reference",
      "CLOUDFLARE_DNS_TOKEN is an unresolved op:// reference",
      "PORT must be between 0 and 65535",
    ]);
    expect(found.join("\n")).not.toContain("relay-item");
    expect(problems({ ...xffEnv, ACME_ACCOUNT_EMAIL: reference })).toEqual([
      "ACME_ACCOUNT_EMAIL is an unresolved op:// reference",
    ]);
  });

  it("accepts a backup push URL on https or on a tailnet http address only", () => {
    for (const url of [
      "https://status.example/api/push/abc?status=up",
      "http://100.64.0.1:3001/api/push/abc",
      "http://100.127.255.254/api/push/abc",
    ]) {
      expect(
        parseRelayConfig({ ...xffEnv, RELAY_BACKUP_PUSH_URL: ` ${url} ` })
          .backupPushUrl,
        url,
      ).toBe(url);
    }

    expect(
      parseRelayConfig({ ...xffEnv, RELAY_BACKUP_PUSH_URL: "" }).backupPushUrl,
    ).toBeNull();

    for (const url of [
      "http://status.example/api/push/abc",
      "http://100.63.255.255/api/push/abc",
      "http://100.128.0.1/api/push/abc",
      "http://10.0.0.5/api/push/abc",
      "http://[fd7a:115c:a1e0::1]/api/push/abc",
      "ftp://status.example/push",
      "status.example/api/push/abc",
    ]) {
      const found = problems({ ...xffEnv, RELAY_BACKUP_PUSH_URL: url });

      expect(found, url).toEqual([
        "RELAY_BACKUP_PUSH_URL must be an https URL, or an http URL on a 100.64.0.0/10 tailnet IPv4 address",
      ]);
      expect(found.join("\n")).not.toContain(url);
    }
  });

  it("takes the security.txt contact from RELAY_SECURITY_CONTACT, and refuses anything but an email address", () => {
    expect(
      parseRelayConfig({
        ...xffEnv,
        RELAY_SECURITY_CONTACT: " Abuse@Omnyo.link ",
      }).securityContact,
    ).toBe("abuse@omnyo.link");
    expect(
      parseRelayConfig({ ...xffEnv, RELAY_SECURITY_CONTACT: "" })
        .securityContact,
    ).toBe("abuse@relay.example");

    for (const value of [
      "abuse",
      "abuse@",
      "abuse@localhost",
      "mailto:abuse@relay.example",
      "abuse@relay.example\nContact: x",
    ]) {
      expect(
        problems({ ...xffEnv, RELAY_SECURITY_CONTACT: value }),
        value,
      ).toEqual([
        "RELAY_SECURITY_CONTACT must be an email address such as abuse@relay.example",
      ]);
    }
  });

  it("names every missing required variable without echoing values", () => {
    const found = problems({ BETTER_AUTH_SECRET: "short-value" });
    expect(found).toEqual(
      expect.arrayContaining([
        "BASE_DOMAIN is required",
        "APP_URL is required",
        "GITHUB_CLIENT_ID is required",
        "GITHUB_CLIENT_SECRET is required",
        "DATABASE_PATH is required",
        "PORT is required",
        "HEALTH_PORT is required",
        "BETTER_AUTH_SECRET must be at least 32 characters",
      ]),
    );
    expect(found.join("\n")).not.toContain("short-value");
  });

  it("requires every option P variable and refuses them under option R", () => {
    expect(
      problems({
        ...proxyEnv,
        RELAY_PROXY_CIDR: undefined,
        CLOUDFLARE_DNS_TOKEN: "",
      }),
    ).toEqual([
      "RELAY_PROXY_CIDR is required",
      "CLOUDFLARE_DNS_TOKEN is required",
    ]);
    expect(problems({ ...proxyEnv, RELAY_PROXY_CIDR: "10.0.1.0/40" })).toEqual([
      "RELAY_PROXY_CIDR must be an IPv4 or IPv6 CIDR such as 10.0.1.0/24",
    ]);
    expect(problems({ ...xffEnv, CLOUDFLARE_DNS_TOKEN: "dns-value" })).toEqual([
      "CLOUDFLARE_DNS_TOKEN is valid only with RELAY_CLIENT_IP_SOURCE=proxy-protocol",
    ]);
    expect(
      problems({ ...xffEnv, CLOUDFLARE_ZONE_ID: proxyEnv.CLOUDFLARE_ZONE_ID }),
    ).toEqual([
      "CLOUDFLARE_ZONE_ID is valid only with RELAY_CLIENT_IP_SOURCE=proxy-protocol",
    ]);
  });

  it("requires a Cloudflare zone id under option P without looking it up", () => {
    expect(problems({ ...proxyEnv, CLOUDFLARE_ZONE_ID: undefined })).toEqual([
      "CLOUDFLARE_ZONE_ID is required",
    ]);
    expect(problems({ ...proxyEnv, CLOUDFLARE_ZONE_ID: "omnyo.link" })).toEqual(
      [
        "CLOUDFLARE_ZONE_ID must be a 32-character lowercase hexadecimal Cloudflare zone id",
      ],
    );
  });

  it("requires APP_URL to be the https apex of BASE_DOMAIN", () => {
    expect(problems({ ...xffEnv, APP_URL: "https://other.example" })).toEqual([
      "APP_URL host must equal BASE_DOMAIN",
    ]);
    expect(
      problems({ ...xffEnv, APP_URL: "http://relay.example/path" }),
    ).toEqual([
      "APP_URL must use https (http is allowed only for *.localhost)",
      "APP_URL must be an origin without a path, query or fragment",
    ]);
    expect(
      parseRelayConfig({
        ...xffEnv,
        BASE_DOMAIN: "omnyo.localhost",
        APP_URL: "http://omnyo.localhost:8787",
      }).appUrl,
    ).toBe("http://omnyo.localhost:8787");
  });

  it("requires a GitHub user ID allowlist on a public domain", () => {
    const publicEnv = {
      ...proxyEnv,
      BASE_DOMAIN: "stg.omnyo.link",
      APP_URL: "https://stg.omnyo.link",
    };

    expect(problems(publicEnv)).toEqual([
      "RELAY_ALLOWED_GITHUB_IDS is required outside the reserved test domains .test, .example, .invalid and .localhost, unless RELAY_SIGNUP is open",
    ]);
    expect(
      parseRelayConfig({
        ...publicEnv,
        RELAY_ALLOWED_GITHUB_IDS: " 583231, 9919 ,583231",
      }).github,
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-value",
      allowedUserIds: ["583231", "9919"],
    });

    for (const invalid of ["octocat", "583231,", "0", "-5", "1.5", "0583231"]) {
      expect(
        problems({ ...publicEnv, RELAY_ALLOWED_GITHUB_IDS: invalid }),
        invalid,
      ).toEqual([
        "RELAY_ALLOWED_GITHUB_IDS must list numeric GitHub user IDs separated by commas",
      ]);
    }
  });

  it("opens GitHub sign-up on a public domain only when RELAY_SIGNUP says so", () => {
    const publicEnv = {
      ...proxyEnv,
      BASE_DOMAIN: "omnyo.link",
      APP_URL: "https://omnyo.link",
    };

    expect(
      parseRelayConfig({ ...publicEnv, RELAY_SIGNUP: "open" }).github,
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-value",
      openSignUp: true,
    });
    expect(
      problems({
        ...publicEnv,
        RELAY_SIGNUP: "open",
        RELAY_ALLOWED_GITHUB_IDS: "1",
      }),
    ).toEqual([
      "RELAY_ALLOWED_GITHUB_IDS must be empty when RELAY_SIGNUP is open",
    ]);
    expect(
      problems({ ...publicEnv, RELAY_SIGNUP: "allowlist" }).join("\n"),
    ).toContain("RELAY_ALLOWED_GITHUB_IDS is required");
    expect(
      problems({ ...publicEnv, RELAY_SIGNUP: "everyone" }).join("\n"),
    ).toContain("RELAY_SIGNUP");
  });

  it("never opens sign-up on a public domain by accident", () => {
    const publicEnv = {
      ...proxyEnv,
      BASE_DOMAIN: "omnyo.link",
      APP_URL: "https://omnyo.link",
    };

    for (const value of [undefined, "", "   ", "allowlist", " allowlist "]) {
      const github = parseRelayConfig({
        ...publicEnv,
        RELAY_SIGNUP: value,
        RELAY_ALLOWED_GITHUB_IDS: "4242,5150",
      }).github;

      expect(github.openSignUp, JSON.stringify(value)).toBeUndefined();
      expect(github.allowedUserIds).toEqual(["4242", "5150"]);

      for (const ids of [undefined, "  ", ","]) {
        expect(
          problems({
            ...publicEnv,
            RELAY_SIGNUP: value,
            RELAY_ALLOWED_GITHUB_IDS: ids,
          }).join("\n"),
          `${JSON.stringify(value)} ${JSON.stringify(ids)}`,
        ).toContain("RELAY_ALLOWED_GITHUB_IDS");
      }
    }

    for (const value of [
      "Open",
      "OPEN",
      "opne",
      "true",
      "1",
      "yes",
      "on",
      "open,allowlist",
      "allowlist open",
      "*",
    ]) {
      for (const ids of [undefined, "4242"]) {
        expect(
          problems({
            ...publicEnv,
            RELAY_SIGNUP: value,
            RELAY_ALLOWED_GITHUB_IDS: ids,
          }).join("\n"),
          value,
        ).toContain("RELAY_SIGNUP must be one of allowlist, open");
      }
    }

    for (const value of ["open", " open ", "open\n"]) {
      const github = parseRelayConfig({
        ...publicEnv,
        RELAY_SIGNUP: value,
      }).github;

      expect(github.openSignUp, JSON.stringify(value)).toBe(true);
      expect(github.allowedUserIds).toBeUndefined();
    }
  });

  it("leaves GitHub sign-up open only on reserved test domains", () => {
    expect(parseRelayConfig(xffEnv).github).toEqual({
      clientId: "client-id",
      clientSecret: "client-value",
    });
    expect(
      parseRelayConfig({ ...xffEnv, RELAY_ALLOWED_GITHUB_IDS: "1" }).github
        .allowedUserIds,
    ).toEqual(["1"]);
  });

  it("rejects an unknown client IP source and invalid numbers", () => {
    expect(
      problems({
        ...xffEnv,
        RELAY_CLIENT_IP_SOURCE: "cf-connecting-ip",
        PORT: "70000",
        RELAY_MAX_BUFFERED_MB: "-1",
        RELAY_PREVIEW_MB_PER_LABEL_PER_DAY: "0",
      }),
    ).toEqual([
      "PORT must be between 0 and 65535",
      "RELAY_CLIENT_IP_SOURCE must be one of proxy-protocol, xff-rightmost",
      "RELAY_MAX_BUFFERED_MB must be a positive number",
      "RELAY_PREVIEW_MB_PER_LABEL_PER_DAY must be a positive number",
    ]);
  });
});
