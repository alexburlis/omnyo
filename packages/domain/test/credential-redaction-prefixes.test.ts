import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_REDACTION_MARKER,
  redactCredentialPayload,
  redactCredentialText,
} from "../src/credential-redaction.js";

function issuedKey(prefix: string): string {
  return `${prefix}_${"A1b2".repeat(8)}`;
}

describe("redaction of Omnyo-issued key prefixes", () => {
  it.each([
    "omnyode",
    "omnyodh",
    "omnyocm",
    "omnyocred",
    "bbde",
    "bbdh",
    "bbcm",
    "bbcred",
  ])("masks a %s key inside text", (prefix) => {
    const key = issuedKey(prefix);
    const redacted = redactCredentialText(`worker reported ${key} on boot`);

    expect(redacted).toBe(
      `worker reported ${CREDENTIAL_REDACTION_MARKER} on boot`,
    );
  });

  it.each(["omnyo", "omnyoxx", "bb", "bbxx"])(
    "leaves the ordinary word %s alone",
    (prefix) => {
      const text = `${prefix}_config value`;

      expect(redactCredentialText(text)).toBe(text);
    },
  );
});

it("masks an OpenSEO workspace key embedded in plain text", () => {
  const sample = `oseo_${"test.".repeat(6)}_${"x".repeat(8)}-`;
  expect(redactCredentialText(`failed (${sample})`)).toBe(
    `failed (${CREDENTIAL_REDACTION_MARKER})`,
  );
});

it("masks GitHub token formats inside a provider recording line", () => {
  const samples = [
    `ghp_${"a".repeat(36)}`,
    `gho_${"b".repeat(36)}`,
    `ghu_${"c".repeat(36)}`,
    `ghs_${"d".repeat(36)}`,
    `ghs_12345_${"e".repeat(12)}.${"f".repeat(12)}.${"g".repeat(12)}`,
    `ghr_${"h".repeat(36)}`,
    `github_pat_${"i".repeat(82)}`,
  ];

  const value = redactCredentialPayload({
    line: JSON.stringify({ values: samples }),
  });

  expect(value.line).toBe(
    JSON.stringify({ values: samples.map(() => CREDENTIAL_REDACTION_MARKER) }),
  );
});
