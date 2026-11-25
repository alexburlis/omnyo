import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsageResult,
  providerUsageWindowSchema,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_killPortableProcess as killPortableProcess,
  experimental_npmCommand as npmCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_spawnPortableProcess as spawnPortableProcess,
  experimental_versionFrom as versionFrom,
} from "@omnyo/plugin-sdk/provider-bridge";
import { z } from "zod";

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

const CLAUDE_INSTALL_SCRIPT_URL = "https://claude.ai/install.sh";

const CLAUDE_POWERSHELL_INSTALL_SCRIPT_URL = "https://claude.ai/install.ps1";

const claudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().nullish().catch(null),
  apiProvider: z.string().nullish().catch(null),
  email: z.email().nullish().catch(null),
  subscriptionType: z.string().trim().min(1).nullish().catch(null),
  loginExpiresAt: z.iso.datetime().nullish().catch(null),
});

type ClaudeAuthStatus = z.infer<typeof claudeAuthStatusSchema>;

const authStatusUnavailable = "Claude Code did not report its login status.";

async function claudeExecutable(): Promise<string> {
  const explicit = process.env.OMNYO_CLAUDE_CODE_EXECUTABLE?.trim();

  if (explicit) return explicit;

  if (
    process.platform !== "win32" ||
    (await resolveExecutablePath("claude")) !== null
  ) {
    return "claude";
  }

  const nativePath = path.join(os.homedir(), ".local", "bin", "claude.exe");

  try {
    await fs.access(nativePath);

    return nativePath;
  } catch {
    return "claude";
  }
}

function claudeInstallerCommand() {
  return downloadedInstallerCommand(CLAUDE_INSTALL_SCRIPT_URL, {
    powershellUrl: CLAUDE_POWERSHELL_INSTALL_SCRIPT_URL,
  });
}

function claudeDistTags(value: string | null): {
  latest: string;
  stable: string | null;
} | null {
  if (value === null) return null;

  try {
    const distTagsSchema = z.object({
      latest: z.string().min(1),
      stable: z.string().min(1).optional(),
    });

    const parsed = z
      .union([
        distTagsSchema,
        z.tuple([distTagsSchema]).transform(([tags]) => tags),
      ])
      .safeParse(JSON.parse(value));

    if (!parsed.success) return null;
    const latest = versionFrom(parsed.data.latest);

    if (latest === null) return null;

    return {
      latest,
      stable:
        parsed.data.stable === undefined
          ? latest
          : versionFrom(parsed.data.stable),
    };
  } catch {
    return null;
  }
}

function claudeDoctor(value: string | null): {
  installMethod: "native" | "npm-global" | "package-manager" | "unknown" | null;
  updateChannel: "latest" | "stable" | null;
} {
  const running =
    value === null ? null : /^Running:\s+([^\s(]+)/mu.exec(value)?.[1];

  const channel =
    value === null
      ? null
      : /^Auto-update channel:\s+(latest|stable)\s*$/mu.exec(value)?.[1];

  return {
    installMethod:
      running === "native" || running === "npm-global"
        ? running
        : running !== null && running !== undefined
          ? ["homebrew", "winget", "apt", "dnf", "apk"].includes(running)
            ? "package-manager"
            : "unknown"
          : null,
    updateChannel:
      channel === "latest" || channel === "stable" ? channel : null,
  };
}

function isDefaultNativeClaudePath(executablePath: string | null): boolean {
  if (executablePath === null) return false;
  const normalized = executablePath.replace(/\\/gu, "/");

  return (
    normalized.endsWith("/.local/bin/claude") ||
    (process.platform === "win32" &&
      normalized.endsWith("/.local/bin/claude.exe"))
  );
}

export async function getClaudeProviderInstallationStatus(
  checkUpdates = true,
): Promise<ProviderInstallationStatus> {
  const command = await claudeExecutable();

  const [
    resolvedExecutable,
    versionOutput,
    tagsOutput,
    npmGlobal,
    doctorOutput,
  ] = await Promise.all([
    resolveExecutablePath(command),
    commandOutput(command, ["--version"]),
    checkUpdates
      ? commandOutput(npmCommand(), [
          "view",
          CLAUDE_NPM_PACKAGE,
          "dist-tags",
          "--json",
        ])
      : null,
    checkUpdates
      ? probeNpmGlobalPackage(CLAUDE_NPM_PACKAGE)
      : { npmBin: null, npmGlobalPackageVersion: null },
    checkUpdates ? commandOutput(command, ["doctor"]) : null,
  ]);

  const installed = resolvedExecutable !== null || versionOutput !== null;
  const currentVersion = versionFrom(versionOutput);
  const doctor = claudeDoctor(doctorOutput);
  const tags = claudeDistTags(tagsOutput);

  const latestVersion =
    doctor.updateChannel === null || tags === null
      ? null
      : tags[doctor.updateChannel];

  const definitelyNeedsUnknownChannelUpdate =
    installed &&
    currentVersion !== null &&
    tags?.stable !== null &&
    tags?.stable !== undefined &&
    compareVersions(tags.latest, currentVersion) > 0 &&
    compareVersions(tags.stable, currentVersion) > 0;

  const needsUpdate =
    installed && currentVersion !== null && latestVersion !== null
      ? compareVersions(latestVersion, currentVersion) > 0
      : definitelyNeedsUnknownChannelUpdate;

  const installSource = npmGlobalInstallSource({
    installed,
    executablePath: resolvedExecutable,
    npmBin: npmGlobal.npmBin,
  });

  const nativeFallback =
    doctor.installMethod === null &&
    installSource === "external" &&
    isDefaultNativeClaudePath(resolvedExecutable);

  const canRunUpdate =
    doctor.installMethod === "native" ||
    nativeFallback ||
    (installSource === "npmGlobal" &&
      (doctor.installMethod === null || doctor.installMethod === "npm-global"));

  const actionKind = !installed
    ? "install"
    : needsUpdate && canRunUpdate
      ? "update"
      : null;

  const displayCommand =
    actionKind === "install"
      ? claudeInstallerCommand().displayCommand
      : formatCommand(command, ["update"]);

  return {
    executableName: command,
    executablePath: resolvedExecutable,
    installed,
    installSource,
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: CLAUDE_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command: displayCommand,
          },
    needsUpdate,
    versionUnsupported: false,
  };
}

export async function getClaudeProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getClaudeProviderInstallationStatus();

  return buildClaudeProviderInstallationRun(status, action);
}

function buildClaudeProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
): ProviderInstallationRunResult {
  const command = status.executableName;

  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Claude Code ${action} is no longer available on this host.`,
    };
  }

  const execution =
    action === "install"
      ? claudeInstallerCommand()
      : {
          command: status.executablePath ?? command,
          args: ["update"],
          displayCommand: formatCommand(command, ["update"]),
        };

  return {
    available: true,
    command: execution,
    verification: installationVerification(status, action),
  };
}

async function claudeAuthStatus(
  command: string,
  env?: NodeJS.ProcessEnv,
): Promise<ClaudeAuthStatus | null> {
  const output = await new Promise<string | null>((resolve) => {
    const child = spawnPortableProcess({
      command,
      args: ["auth", "status"],
      stdio: ["ignore", "pipe", "ignore"],
      ...(env === undefined ? {} : { env }),
    });

    const timeout = setTimeout(stop, 10_000);
    let stdout = "";

    function stop() {
      clearTimeout(timeout);
      child.stdout?.removeAllListeners("data");
      resolve(null);
      killPortableProcess(child, "SIGKILL");
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;

      if (stdout.length > 64 * 1024) stop();
    });
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 || code === 1 ? stdout : null);
    });
  }).catch(() => null);

  if (output === null) return null;

  try {
    const parsed = claudeAuthStatusSchema.safeParse(JSON.parse(output));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function claudeAccountDetails(auth: ClaudeAuthStatus) {
  const subscription = auth.subscriptionType;

  return {
    accountEmail: auth.email ?? null,
    planLabel: subscription
      ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
      : null,
  };
}

function claudeLoginExpired(auth: ClaudeAuthStatus): boolean {
  return (
    auth.loginExpiresAt != null && Date.parse(auth.loginExpiresAt) <= Date.now()
  );
}

function healthResult(
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  args: {
    accountEmail?: string | null;
    planLabel?: string | null;
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: args.planLabel ?? null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: "claude auth login",
    },
  };
}

export async function getClaudeProviderHealth(): Promise<ProviderHealthResult> {
  const command = await claudeExecutable();

  if ((await resolveExecutablePath(command)) === null) {
    return healthResult("not_installed");
  }

  const [installedVersion, auth] = await Promise.all([
    readCliVersion(command),
    claudeAuthStatus(command),
  ]);

  if (auth === null)
    return healthResult("unknown", {
      installedVersion,
      statusMessage: authStatusUnavailable,
    });

  const known = { installedVersion, ...claudeAccountDetails(auth) };

  if (!auth.loggedIn) return healthResult("unauthenticated", known);

  return healthResult(claudeLoginExpired(auth) ? "expired" : "ready", known);
}

async function readSubscriptionUsage(
  command: string,
  env: NodeJS.ProcessEnv,
  email: string,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_000);

  const session = query({
    prompt: (async function* () {
      if (!controller.signal.aborted)
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
    })(),
    options: {
      abortController: controller,
      pathToClaudeCodeExecutable: command,
      env,
      persistSession: false,
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      mcpServers: {},
    },
  });

  try {
    const [account, report] = await Promise.all([
      session.accountInfo(),
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
        skipBehaviors: true,
      }),
    ]);

    const limits = report.rate_limits;

    if (
      account.email?.toLowerCase() !== email.toLowerCase() ||
      !report.rate_limits_available ||
      limits === null
    )
      return null;

    return [
      {
        label: "5H",
        usedPercent: limits.five_hour?.utilization,
        resetsAt: limits.five_hour?.resets_at ?? null,
      },
      {
        label: "7D",
        usedPercent: limits.seven_day?.utilization,
        resetsAt: limits.seven_day?.resets_at ?? null,
      },
    ].flatMap((window) => {
      const parsed = providerUsageWindowSchema.safeParse(window);

      return parsed.success ? [parsed.data] : [];
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    session.close();
  }
}

export async function getClaudeProviderUsage(
  profileEnv?: Record<string, string>,
): Promise<ProviderUsageResult> {
  const profileCommand = profileEnv?.OMNYO_CLAUDE_CODE_EXECUTABLE;
  const command = profileCommand ?? (await claudeExecutable());

  const env =
    profileCommand === undefined
      ? undefined
      : { ...process.env, ...profileEnv };

  if ((await resolveExecutablePath(command)) === null)
    return { supported: true, usage: { status: "not_installed" } };

  const auth = await claudeAuthStatus(command, env);

  if (auth === null)
    return {
      supported: true,
      usage: {
        status: "error",
        message: authStatusUnavailable,
        planLabel: null,
        accountEmail: null,
      },
    };

  if (
    !auth.loggedIn ||
    (env !== undefined &&
      (auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty"))
  )
    return { supported: true, usage: { status: "unauthenticated" } };

  if (claudeLoginExpired(auth))
    return { supported: true, usage: { status: "expired" } };

  if (env !== undefined) {
    const windows =
      auth.email == null
        ? null
        : await readSubscriptionUsage(command, env, auth.email).catch(
            () => null,
          );

    return {
      supported: true,
      profileScoped: true,
      usage:
        windows === null
          ? {
              status: "error",
              message: "Claude Code could not read the subscription limits.",
              ...claudeAccountDetails(auth),
            }
          : { status: "ok", windows, ...claudeAccountDetails(auth) },
    };
  }

  return {
    supported: true,
    usage: {
      status: "error",
      message: "Run /usage in Claude Code to see your current limits.",
      ...claudeAccountDetails(auth),
    },
  };
}

export const __testing = {
  buildProviderInstallationRun: buildClaudeProviderInstallationRun,
};
