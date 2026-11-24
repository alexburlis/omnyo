import { expect, it } from "vitest";
import { OMNYO_SERVER_HEADERS_ENV } from "../src/env-vars.js";
import { parseAppManagedConfig } from "../src/managed-app-config.js";
import { importLegacyWireHeadersV1 } from "../src/legacy-wire-headers-v1.js";

it("projects the exact saved machine header without changing principal values or opaque user headers", () => {
  const source = {
    "X-BB-Connect-Machine": "legacy-principal-placeholder",
    "X-Custom-User": "opaque-user-content",
  };

  const result = importLegacyWireHeadersV1(source);
  expect(result).toEqual({
    "x-omnyo-connect-machine": "legacy-principal-placeholder",
    "X-Custom-User": "opaque-user-content",
  });
  expect(source).toHaveProperty(
    "X-BB-Connect-Machine",
    "legacy-principal-placeholder",
  );
  expect(importLegacyWireHeadersV1(result)).toEqual(result);
});

it.each([false, true])(
  "refuses divergent case-insensitive header collisions in either order (%s)",
  (reverse) => {
    const pairs = [
      ["X-BB-Connect-Machine", "legacy-principal-placeholder"],
      ["X-OMNYO-Connect-Machine", "different-principal-placeholder"],
    ];

    if (reverse) pairs.reverse();
    expect(() => importLegacyWireHeadersV1(Object.fromEntries(pairs))).toThrow(
      /Conflicting/,
    );
  },
);

it("normalizes effective managed config and environment headers through their real owners", () => {
  const headers = { "x-bb-connect-machine": "legacy-principal-placeholder" };
  expect(
    parseAppManagedConfig({ serverHeaders: headers }).serverHeaders,
  ).toEqual({ "x-omnyo-connect-machine": "legacy-principal-placeholder" });
  expect(
    OMNYO_SERVER_HEADERS_ENV.parse({
      context: { homeDir: "/synthetic" },
      name: "OMNYO_SERVER_HEADERS",
      value: JSON.stringify(headers),
    }),
  ).toEqual({ "x-omnyo-connect-machine": "legacy-principal-placeholder" });
  expect(headers).toHaveProperty("x-bb-connect-machine");
});

it("refuses conflicting saved headers at both real read boundaries", () => {
  const headers = {
    "x-bb-connect-machine": "legacy-principal-placeholder",
    "x-omnyo-connect-machine": "different-principal-placeholder",
  };

  expect(() => parseAppManagedConfig({ serverHeaders: headers })).toThrow();
  expect(() =>
    OMNYO_SERVER_HEADERS_ENV.parse({
      context: { homeDir: "/synthetic" },
      name: "OMNYO_SERVER_HEADERS",
      value: JSON.stringify(headers),
    }),
  ).toThrow();
});
