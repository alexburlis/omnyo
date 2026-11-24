import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function routerPatterns(environment: "production" | "staging") {
  const source = readFileSync(
    new URL(`../deploy/traefik-${environment}.yaml`, import.meta.url),
    "utf8",
  );

  const rules = [
    ...source.matchAll(/rule: '(Host(?:SNI)?Regexp)\(`([^`]+)`\)'/gu),
  ];

  expect(rules.map((rule) => rule[1])).toEqual(["HostSNIRegexp", "HostRegexp"]);
  expect(source).toContain("passthrough: true");
  expect(source).toContain("version: 2");
  expect(source).toContain("scheme: https");
  expect(source).toContain(
    `priority: ${environment === "staging" ? 200 : 100}`,
  );

  return rules.map((rule) => new RegExp(rule[2], "u"));
}

describe("relay deployment host isolation", () => {
  it.each(["production", "staging"] as const)(
    "routes only %s hosts through TLS and HTTP",
    (environment) => {
      const domain =
        environment === "production" ? "omnyo.link" : "stg.omnyo.link";

      for (const pattern of routerPatterns(environment)) {
        expect(pattern.test(domain)).toBe(true);
        expect(pattern.test(`alice.${domain}`)).toBe(true);

        for (const host of [
          "slashnew.com",
          "alice.slashnew.com",
          "stg.slashnew.com",
          "alice.stg.slashnew.com",
          `a.b.${domain}`,
          `${domain}.example.com`,
          "example.com",
          ...(environment === "production"
            ? ["stg.omnyo.link", "alice.stg.omnyo.link"]
            : ["omnyo.link", "alice.omnyo.link"]),
        ]) {
          expect(pattern.test(host), host).toBe(false);
        }
      }
    },
  );
});
