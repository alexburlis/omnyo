/// <reference types="node" />

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  redactCredentialPayload,
  redactCredentialText,
} from "../src/credential-redaction.js";

function shaped(...parts: string[]): string {
  return parts.join("");
}

describe("credential payload redaction", () => {
  it.each([
    [
      "a private key block",
      shaped(
        "-----BEGIN ",
        "PRIVATE KEY-----\nabc\n-----END ",
        "PRIVATE KEY-----",
      ),
    ],
    ["a provider key", shaped("sk", "-", "x".repeat(12))],
    ["a GitHub token", shaped("gh", "p_", "x".repeat(12))],
    ["a GitHub fine-grained token", shaped("github", "_pat_", "x".repeat(12))],
    ["a Slack token", shaped("xo", "xb-", "x".repeat(12))],
    ["an Omnyo token", shaped("bb", "de_", "x".repeat(12))],
    ["an AWS access key id", shaped("AK", "IA", "X".repeat(16))],
    ["a JWT", shaped("ey", "Jhbg", ".", "e30", ".", "sig")],
    ["a bearer value", shaped("bear", "er ", "opaque-fixture")],
  ])("removes %s from nested strings", (_label, secret) => {
    const value = { outer: [{ text: `before ${secret} after` }] };

    expect(JSON.stringify(redactCredentialPayload(value))).not.toContain(
      secret.split(" ").at(-1),
    );
  });

  it("shares unchanged subtrees, copies changed paths and leaves the input intact", () => {
    const label = shaped("pass", "word");
    const untouched = { list: [1, 2, { text: "plain" }] };
    const changed = { [label]: "fixture-value" };
    const value = { untouched, changed };

    const result = redactCredentialPayload(value);

    expect(result).not.toBe(value);
    expect(result.untouched).toBe(untouched);
    expect(result.changed).toEqual({ [label]: "[REDACTED]" });
    expect(changed[label]).toBe("fixture-value");
    expect(redactCredentialPayload(untouched)).toBe(untouched);
  });

  it("redacts inside JSON-looking strings and keeps other text", () => {
    const label = shaped("api", "Key");

    const nested = JSON.stringify({
      [label]: "fixture-value",
      note: "visible",
    });

    const result = redactCredentialPayload({
      output: nested,
      other: "[not json",
    });

    expect(JSON.parse(result.output)).toEqual({
      [label]: "[REDACTED]",
      note: "visible",
    });
    expect(result.other).toBe("[not json");
  });

  it("applies known values from a list that changes between calls", () => {
    const values = ["fixture-alpha"];

    expect(redactCredentialText("x fixture-alpha fixture-beta", values)).toBe(
      "x [REDACTED] fixture-beta",
    );

    values.push("fixture-beta");

    expect(redactCredentialText("x fixture-alpha fixture-beta", values)).toBe(
      "x [REDACTED] [REDACTED]",
    );
  });

  it("redacts with a frozen known-value list on every call", () => {
    const values = Object.freeze(["fixture-alpha"]);

    expect(redactCredentialPayload({ text: "fixture-alpha" }, values)).toEqual({
      text: "[REDACTED]",
    });
    expect(
      redactCredentialPayload({ text: "fixture-alpha again" }, values),
    ).toEqual({ text: "[REDACTED] again" });
  });
});

describe("credential text redaction", () => {
  it("does not block on a long non-credential token before an assignment", () => {
    const require = createRequire(import.meta.url);
    const source = new URL("../src/credential-redaction.ts", import.meta.url);

    const script = `
      import { redactCredentialText } from ${JSON.stringify(source.href)};
      const input = "a".repeat(200_000) + " visible=value";
      if (redactCredentialText(input) !== input) process.exitCode = 1;
    `;

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx/esm"),
        "--input-type=module",
        "-e",
        script,
      ],
      { timeout: 2_000, encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.each(["TOKEN", "123TOKEN", "_123.TOKEN", "api-key", "'password'"])(
    "preserves redaction for the label %s",
    (label) => {
      expect(redactCredentialText(`${label}=fixture`)).toBe(
        `${label}=[REDACTED]`,
      );
    },
  );

  it("keeps public fields and ordinary assignments visible", () => {
    const input = "PUBLIC_TOKEN=visible ordinary.field=value 12345=number";

    expect(redactCredentialText(input)).toBe(input);
  });
});
