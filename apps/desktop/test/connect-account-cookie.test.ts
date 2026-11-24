import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CONNECT_ACCOUNT_SESSION_COOKIE } from "../src/connect-account-cookie.js";

it("waits for the session cookie name the relay account site sets", () => {
  const relayCookies = readFileSync(
    join(__dirname, "..", "..", "relay", "src", "auth", "cookies.ts"),
    "utf8",
  );

  const prefix = /AUTH_COOKIE_PREFIX = "([^"]+)"/u.exec(relayCookies)?.[1];

  expect(prefix).toBeDefined();
  expect(relayCookies).toContain(
    "SESSION_COOKIE_NAME = `${AUTH_COOKIE_PREFIX}.session_token`",
  );
  expect(CONNECT_ACCOUNT_SESSION_COOKIE).toBe(`${prefix}.session_token`);
});
