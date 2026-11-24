import type { Hono } from "hono";
import {
  getGateAuthKind,
  getTrustedRemoteAddress,
} from "../request-context.js";
import { getMachineEnrollmentService } from "../services/machines/machine-services.js";
import {
  enrolledInstallerScript,
  enrolledWindowsInstallerScript,
  shellInstallerFailureScript,
  shortEnrollmentCommand,
  shortEnrollmentPowerShellCommand,
  windowsInstallerFailureScript,
} from "../services/machines/manual-enrollment-command.js";
import {
  type ShortEnrollmentFailureLimiter,
  createShortEnrollmentFailureLimiter,
  formatShortEnrollmentCode,
  normalizeShortEnrollmentCode,
} from "../services/machines/short-enrollment-code.js";
import type { ServerAppDeps } from "../types.js";

const RELAY_CLIENT_IP_HEADER = "x-omnyo-client-ip";

const INVALID_CODE_MESSAGE =
  "This setup code is invalid, expired, or already used. Generate a new command in Omnyo under Settings, Machines.";

const RATE_LIMITED_MESSAGE =
  "Too many incorrect setup codes. Wait 10 minutes, then run the command again.";

const SHELL_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/x-shellscript; charset=utf-8",
};

const POWERSHELL_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
};

const BROWSER_PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "text/plain; charset=utf-8",
  "x-content-type-options": "nosniff",
};

function browserSetupPage(input: {
  serverUrl: string;
  code: string;
  expiresAt: number;
  windowsFirst: boolean;
}): string {
  const posix = [
    "On macOS or Linux, paste this into Terminal:",
    "",
    shortEnrollmentCommand(input.serverUrl, input.code),
  ];

  const windows = [
    "On Windows, paste this into PowerShell:",
    "",
    shortEnrollmentPowerShellCommand(input.serverUrl, input.code),
  ];

  const minutes = Math.max(
    1,
    Math.ceil((input.expiresAt - Date.now()) / 60_000),
  );

  return [
    "Add this machine to Omnyo",
    "",
    ...(input.windowsFirst ? windows : posix),
    "",
    ...(input.windowsFirst ? posix : windows),
    "",
    `Setup code ${input.code} works once and expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    "",
  ].join("\n");
}

export interface MachineInstallerSources {
  shell(): Promise<string>;
  windows(): Promise<string>;
}

export function registerShortEnrollmentRoutes(
  app: Hono,
  deps: ServerAppDeps,
  installers: MachineInstallerSources,
  limiter: ShortEnrollmentFailureLimiter = createShortEnrollmentFailureLimiter(),
): void {
  app.get("/m/:code", async (context) => {
    const requested = context.req.param("code");
    const windows = requested.endsWith(".ps1");
    const code = windows ? requested.slice(0, -".ps1".length) : requested;

    const browser =
      context.req.header("accept")?.includes("text/html") ?? false;

    const failure = (message: string) =>
      browser
        ? new Response(`${message}\n`, { headers: BROWSER_PAGE_HEADERS })
        : windows
          ? new Response(windowsInstallerFailureScript(message), {
              headers: POWERSHELL_HEADERS,
            })
          : new Response(shellInstallerFailureScript(message), {
              headers: SHELL_HEADERS,
            });

    const relayedClient =
      getGateAuthKind(context) === null
        ? undefined
        : context.req.header(RELAY_CLIENT_IP_HEADER)?.trim();

    const client = relayedClient
      ? `relay:${relayedClient}`
      : `direct:${getTrustedRemoteAddress(context) ?? "unknown"}`;

    if (limiter.blocked(client)) return failure(RATE_LIMITED_MESSAGE);

    const bootstrap =
      await getMachineEnrollmentService(deps).pendingBootstrapForShortCode(
        code,
      );

    if (bootstrap === null) {
      limiter.recordFailure(client);

      if (limiter.blocked(client))
        deps.logger.warn("Short machine setup code lookups are rate limited");

      return failure(INVALID_CODE_MESSAGE);
    }

    if (browser) {
      const normalized = normalizeShortEnrollmentCode(code);

      const shortCode =
        getMachineEnrollmentService(deps).shortCodeForBootstrap(bootstrap);

      if (normalized === null || shortCode === null)
        return failure(INVALID_CODE_MESSAGE);

      return new Response(
        browserSetupPage({
          serverUrl: bootstrap.serverUrl,
          code: formatShortEnrollmentCode(normalized),
          expiresAt: shortCode.expiresAt,
          windowsFirst:
            context.req.header("user-agent")?.includes("Windows") ?? false,
        }),
        { headers: BROWSER_PAGE_HEADERS },
      );
    }

    return windows
      ? new Response(
          enrolledWindowsInstallerScript(await installers.windows(), bootstrap),
          { headers: POWERSHELL_HEADERS },
        )
      : new Response(
          enrolledInstallerScript(await installers.shell(), bootstrap),
          { headers: SHELL_HEADERS },
        );
  });
}
