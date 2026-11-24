import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeInheritedChildProcessEnv } from "../src/environment.js";

afterEach(() => vi.unstubAllGlobals());

describe("inherited Omnyo environment boundary", () => {
  it("strips the Omnyo runtime namespace and passes unrelated variables", () => {
    const inherited = {
      BB_USER_OWNED: "user-owned",
      OMNYO_ACCOUNT_POOL_PARENT_TOKEN: "new-pool-fixture",
      OMNYO_DATA_DIR: "/new",
      PI_OMNYO_TOOLS_FILE: "/new/tools",
      NODE_ENV: "production",
      PATH: "/bin",
      WEB_BROWSER: "browser",
    };

    const before = { ...inherited };

    expect(sanitizeInheritedChildProcessEnv({ env: inherited })).toEqual({
      BB_USER_OWNED: "user-owned",
      PATH: "/bin",
      WEB_BROWSER: "browser",
    });
    expect(inherited).toEqual(before);
  });

  it("treats namespace and PATH casing as Windows does", () => {
    vi.stubGlobal(
      "process",
      Object.create(process, { platform: { value: "win32" } }),
    );

    expect(
      sanitizeInheritedChildProcessEnv({
        env: {
          omnyo_account_pool_parent_token: "new-pool-fixture",
          pi_omnyo_tools_file: "/new/tools",
          node_env: "production",
          Path: "inherited",
        },
        shellPath: "resolved-shell-path",
      }),
    ).toEqual({ PATH: "resolved-shell-path" });
  });
});
