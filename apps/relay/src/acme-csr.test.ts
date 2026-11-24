import * as acme from "acme-client";
import { describe, expect, it } from "vitest";

describe("acme-client certificate requests", () => {
  it("builds the relay's apex and wildcard request with an ECDSA key", async () => {
    const [, csr] = await acme.crypto.createCsr(
      {
        commonName: "stg.omnyo.link",
        altNames: ["stg.omnyo.link", "*.stg.omnyo.link"],
      },
      await acme.crypto.createPrivateEcdsaKey(),
    );

    expect(acme.crypto.readCsrDomains(csr)).toEqual({
      commonName: "stg.omnyo.link",
      altNames: ["stg.omnyo.link", "*.stg.omnyo.link"],
    });
  });
});
