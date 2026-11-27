import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@omnyo/plugin-sdk/testing/host";
import host from "../host";
import { installFakeGh } from "../testing/fake-gh";

it.each([
  [
    "GraphQL: Resource not accessible by personal access token",
    "GitHub denied this action. Check repository permissions and token scopes.",
  ],
  [
    "HTTP 403: API rate limit exceeded",
    "GitHub rate limit reached. Try again after the limit resets.",
  ],
  [
    "HTTP 404: Not Found",
    "GitHub could not find this repository or item, or your account cannot access it.",
  ],
  ["HTTP 401: Bad credentials", "GitHub authentication failed. Sign in again with gh auth login."],
  [
    "dial tcp: lookup api.github.com: no such host",
    "GitHub could not be reached. Check the network connection.",
  ],
  ["unrecognized failure with private response data", "GitHub CLI request failed (exit code 1)."],
])("reports a safe actionable failure for %s", async (stderr, message) => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-errors-"));

  const restore = installFakeGh(
    scratch,
    `if (args[0] !== "--version") { err(${JSON.stringify(stderr)}); process.exit(1); }`,
  );

  const harness = experimental_createHostEntryHarness(host);

  try {
    await expect(
      harness.experimental_call("gh", { args: ["api", "user"], timeoutMs: 1000 }),
    ).rejects.toMatchObject({ message });
  } finally {
    await harness.experimental_dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("reports a command timeout without exposing command arguments", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "workspace-github-errors-"));
  const restore = installFakeGh(scratch, 'if (args[0] !== "--version") sleepMs(5000);');
  const harness = experimental_createHostEntryHarness(host);

  try {
    await expect(
      harness.experimental_call("gh", { args: ["api", "user"], timeoutMs: 100 }),
    ).rejects.toMatchObject({ message: "GitHub CLI timed out." });
  } finally {
    await harness.experimental_dispose();
    restore();
    rmSync(scratch, { recursive: true, force: true });
  }
});
