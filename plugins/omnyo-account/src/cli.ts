import {
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginApi,
  type PluginCliResult,
} from "@omnyo/plugin-sdk";
import { AccountError, type AccountService } from "./account.js";
import type { AccountStatus, LoginView, SignOutResult } from "./contract.js";
import { HostedRequestError, RedeemError } from "./hosted.js";
import type { LinkLogins } from "./login.js";
import { relayRebindInputSchema } from "./relay-rebind.js";
import { resolveBaseUrl, type BaseUrlPolicy } from "./rpc.js";

const DESCRIPTION = [
  "Sign this Omnyo in to your omnyo.link account. Omnyo account holds the server",
  "credential that remote access (omnyo connect) uses.",
  "",
  "  omnyo account login          Print an omnyo.link link and code to approve",
  "  omnyo account login --wait   Wait here until that sign-in finishes",
  "  omnyo account login --code <code>",
  "                            Pair with a one-time code from the dashboard",
].join("\n");

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const REDEEM_ERROR_TEXT: Record<RedeemError["code"], string> = {
  invalid_code:
    "that code is invalid or has expired — get a new one from the omnyo.link dashboard",
  expired_code:
    "that code has expired — get a new one from the omnyo.link dashboard",
  already_used:
    "that code was already used — get a new one from the omnyo.link dashboard",
  network: "couldn't reach omnyo.link — check the connection and try again",
};

const HOSTED_ERROR_TEXT: Partial<Record<HostedRequestError["code"], string>> = {
  rate_limited:
    "too many sign-in attempts from this network — wait a minute, then try again",
  unavailable:
    "omnyo.link couldn't handle that request right now — try again in a minute",
};

function asJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatAccount(status: AccountStatus): string {
  if (status.state === "profile-pending") {
    return [
      "Paired with omnyo.link, but Omnyo hasn't loaded the account yet; it keeps retrying.",
      "Remote access starts once it does. Check this machine's",
      "connection, or run `omnyo account logout` to sign out and start over.",
    ].join("\n");
  }

  if (status.account === null) {
    return "Not signed in. Run `omnyo account login` to sign in.";
  }

  const account = status.account;

  const login =
    account.githubLogin === null ? "" : ` (@${account.githubLogin})`;

  return [
    `Signed in as ${account.name}${login}`,
    `  Handle:  ${account.handle ?? "none yet"}`,
    `  Server:  ${account.serverLabel}  ${account.serverUrl}`,
  ].join("\n");
}

function formatPendingLogin(view: LoginView): string {
  const minutes = Math.max(
    0,
    Math.round((view.expiresAt - Date.now()) / 60_000),
  );

  return [
    "To sign in this Omnyo, open:",
    `  ${view.verificationUrl}`,
    `and confirm the code ${view.userCode}. It expires in about ${minutes} min.`,
    "",
    "Omnyo finishes signing in on its own once you approve. To wait here for the",
    "result, run:",
    "  omnyo account login --wait",
  ].join("\n");
}

function formatSignOut(result: SignOutResult): string {
  switch (result.revocation) {
    case "not-signed-in":
      return "Not signed in.";
    case "revoked":
      return "Signed out. Remote access stops until you sign in again.";
    case "failed":
      return [
        "Signed out on this Omnyo, but omnyo.link didn't confirm it revoked this server",
        `(${result.message}). Remove the server at ${result.dashboardUrl}.`,
      ].join("\n");
  }
}

function loginFailure(view: LoginView): PluginCliError {
  const reason = view.message ?? `sign-in ${view.state}`;

  return new PluginCliError(
    `${reason} Run \`omnyo account login\` to start again.`,
    { code: `login_${view.state.replace("-", "_")}` },
  );
}

function accountFailure(error: unknown): PluginCliError {
  if (error instanceof PluginCliError) return error;

  if (error instanceof RedeemError) {
    return new PluginCliError(REDEEM_ERROR_TEXT[error.code], {
      code: error.code,
    });
  }

  if (error instanceof AccountError) {
    return new PluginCliError(error.message, { code: error.code });
  }

  if (error instanceof HostedRequestError) {
    return new PluginCliError(HOSTED_ERROR_TEXT[error.code] ?? error.message, {
      code: error.code,
    });
  }

  return new PluginCliError(
    error instanceof Error ? error.message : String(error),
    { code: "account_failed" },
  );
}

async function attempt(
  work: () => Promise<PluginCliResult>,
): Promise<PluginCliResult> {
  try {
    return await work();
  } catch (error) {
    throw accountFailure(error);
  }
}

export function registerAccountCli(args: {
  api: Pick<PluginApi, "cli">;
  account: AccountService;
  logins: LinkLogins;
  baseUrls: BaseUrlPolicy;
}): void {
  const { api: api, account, logins, baseUrls } = args;
  api.cli.register(
    defineCli({
      name: "account",
      summary: "Sign this Omnyo in to your omnyo.link account",
      description: DESCRIPTION,
      root: cliCommand({
        summary: "Show how to sign in",
        run: (input) => ({ exitCode: 0, stdout: input.help }),
      }),
      commands: {
        status: cliCommand({
          summary: "Show which omnyo.link account this Omnyo is signed in to",
          options: { json: JSON_OPTION },
          run: (input) => {
            const status = account.status();
            const login = logins.view(null);

            if (input.options.json) {
              return { exitCode: 0, stdout: asJson({ ...status, login }) };
            }

            const lines = [formatAccount(status)];

            if (login !== null && login.state === "pending") {
              lines.push(
                "",
                `Sign-in waiting for approval: open ${login.verificationUrl} and confirm ${login.userCode}.`,
              );
            }

            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        login: cliCommand({
          summary: "Sign in with an omnyo.link link, or pair with a code",
          description:
            "Without --code, prints an omnyo.link link and a code to approve in any browser, then returns; Omnyo keeps checking and signs in once you approve. --wait waits for that sign-in to finish. Signing in replaces the account this Omnyo is signed in to.",
          options: {
            code: {
              type: "string",
              placeholder: "code",
              description:
                "One-time pairing code from the omnyo.link dashboard",
            },
            wait: {
              type: "boolean",
              description:
                "Wait until the sign-in started by `omnyo account login` is approved, denied, or expires",
            },
            "base-url": {
              type: "string",
              placeholder: "url",
              description:
                "Relay origin: https://omnyo.link or https://stg.omnyo.link (development builds also accept http://omnyo.localhost:<port>)",
            },
            json: JSON_OPTION,
          },
          constraints: [
            { kind: "at-most-one", options: ["code", "wait"] },
            { kind: "at-most-one", options: ["wait", "base-url"] },
          ],
          run: (input, ctx) =>
            attempt(async () => {
              const baseUrl = resolveBaseUrl(
                input.options["base-url"] ?? null,
                baseUrls,
              );

              if (input.options.code !== undefined) {
                const status = await logins.redeemCode(
                  input.options.code.trim(),
                  baseUrl,
                );

                return {
                  exitCode: 0,
                  stdout: input.options.json
                    ? asJson(status)
                    : `${formatAccount(status)}\n`,
                };
              }

              if (input.options.wait) {
                const view = await logins.wait(ctx.signal);

                if (view === null) {
                  throw new PluginCliError(
                    "no sign-in is in progress — run `omnyo account login` first",
                    { code: "no_login" },
                  );
                }

                if (view.state === "pending") {
                  throw new PluginCliError(
                    "stopped waiting; the sign-in is still open",
                    { code: "login_pending" },
                  );
                }

                if (view.state !== "signed-in") throw loginFailure(view);
                const status = account.status();

                return {
                  exitCode: 0,
                  stdout: input.options.json
                    ? asJson({ ...status, login: view })
                    : `${formatAccount(status)}\n`,
                };
              }

              const view = await logins.start(baseUrl);

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? asJson({ login: view, status: account.status() })
                  : `${formatPendingLogin(view)}\n`,
              };
            }),
        }),
        "rebind-relay": cliCommand({
          summary:
            "Move the checkpointed pairing to omnyo.link without signing in again",
          description:
            "Operator migration command. Run against this coordinator over loopback. Verifies the same user, server, label and new address before changing the pairing. --check performs only the identity check. Repeating a completed migration repairs its stored profile without creating a server or credential.",
          options: {
            "from-base-url": {
              type: "string",
              required: true,
              description: "Checkpointed previous relay apex",
            },
            "from-server-url": {
              type: "string",
              required: true,
              description: "Checkpointed previous tenant origin",
            },
            "user-id": {
              type: "string",
              required: true,
              description: "Checkpointed account user ID",
            },
            "server-id": {
              type: "string",
              required: true,
              description: "Checkpointed server ID",
            },
            "server-label": {
              type: "string",
              required: true,
              description: "Checkpointed server address label",
            },
            check: {
              type: "boolean",
              description:
                "Verify the new relay identity without changing local state",
            },
            json: JSON_OPTION,
          },
          run: (input) =>
            attempt(async () => {
              const result = await account.rebindRelay(
                relayRebindInputSchema.parse({
                  fromBaseUrl: input.options["from-base-url"],
                  fromServerUrl: input.options["from-server-url"],
                  userId: input.options["user-id"],
                  serverId: input.options["server-id"],
                  serverLabel: input.options["server-label"],
                  check: input.options.check ?? false,
                }),
              );

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? asJson(result)
                  : `${input.options.check ? "Identity verified. Pairing unchanged." : "Pairing verified at omnyo.link."}\n${formatAccount(result.status)}\n`,
              };
            }),
        }),
        logout: cliCommand({
          summary: "Sign out and forget this Omnyo's omnyo.link pairing",
          description:
            "Revokes the server credential on omnyo.link and forgets it here, and cancels a sign-in that is waiting for approval. Remote access stops until you sign in again. If omnyo.link can't be reached, Omnyo still signs out here and says so; remove the server from the omnyo.link dashboard.",
          options: { json: JSON_OPTION },
          run: (input) =>
            attempt(async () => {
              const result = await logins.signOut();

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? asJson(result)
                  : `${formatSignOut(result)}\n`,
              };
            }),
        }),
      },
    }),
  );
}
