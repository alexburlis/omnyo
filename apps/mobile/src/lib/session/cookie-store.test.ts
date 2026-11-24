import { describe, expect, it } from "vitest";
import { sessionCookieSpec } from "./cookie-store";

const session = {
  cookie: {
    name: "__Secure-bb-connect.desktop_session",
    value: "abc.def",
    domain: ".example.test",
    expiresAt: Date.UTC(2026, 7, 18, 11),
  },
};

describe("sessionCookieSpec", () => {
  it("marks the cookie Secure only for https servers", () => {
    expect(sessionCookieSpec(session, "https://bee.example.test")).toEqual({
      name: "__Secure-bb-connect.desktop_session",
      value: "abc.def",
      domain: ".example.test",
      path: "/",
      secure: true,
      httpOnly: true,
      expires: "2026-08-18T11:00:00.000+00:00",
    });
    expect(
      sessionCookieSpec(
        { cookie: { ...session.cookie, domain: "127.0.0.1" } },
        "http://127.0.0.1:42998",
      ),
    ).toMatchObject({ secure: false, domain: "127.0.0.1" });
  });

  it("rejects a cookie domain the server host does not domain-match", () => {
    const rogue = "https://bee.example.test.evil.example";

    for (const domain of [
      "bee.example.test",
      ".example.test",
      "example.test",
    ]) {
      expect(() =>
        sessionCookieSpec({ cookie: { ...session.cookie, domain } }, rogue),
      ).toThrow(/does not match bee\.example\.test\.evil\.example/u);
    }

    expect(() =>
      sessionCookieSpec(
        { cookie: { ...session.cookie, domain: "ant.example.test" } },
        "https://bee.example.test",
      ),
    ).toThrow(/does not match/u);
    expect(() =>
      sessionCookieSpec(
        { cookie: { ...session.cookie, domain: "ee.example.test" } },
        "https://bee.example.test",
      ),
    ).toThrow(/does not match/u);
  });

  it("accepts the host itself and any parent domain", () => {
    for (const domain of [
      "bee.example.test",
      ".bee.example.test",
      ".example.test",
      "example.test",
      "Example.Test",
    ]) {
      expect(
        sessionCookieSpec(
          { cookie: { ...session.cookie, domain } },
          "https://bee.example.test",
        ),
      ).toMatchObject({ domain });
    }
  });
});
