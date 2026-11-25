import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { withFileLock } from "@omnyo/config/file-lock";
import { resolveExecutable } from "@omnyo/process-utils";
import type {
  ClaudeProfile,
  ClaudeProfileLoginState,
  ClaudeProfileManagementRequest,
  ClaudeProfileManagementResult,
  HostDaemonContributedEnvEntry,
} from "@omnyo/host-daemon-contract";
import { claudeProfileSchema } from "@omnyo/host-daemon-contract";
import { z } from "zod";
import {
  ExpectedCommandDispatchError,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";

const executableVariable = "OMNYO_CLAUDE_CODE_EXECUTABLE";

const verifiedVersion = /^2\.1\.331 \(Claude Code\)\s*$/u;

const duplicateAccountMessage =
  "This Claude account is already added. Sign in with a different account.";

const alternateEnvironment =
  /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|PROFILE|FEDERATION.*|CREDENTIALS.*|API_GATEWAY.*|CUSTOM_HEADERS|BEDROCK_BASE_URL|VERTEX_BASE_URL|FOUNDRY_BASE_URL)|CLAUDE_CODE_(?:OAUTH_TOKEN.*|USE_.*|API_KEY_HELPER.*)|(?:ALL|HTTP|HTTPS)_PROXY)$/iu;

const alternateSetting =
  /^(?:apiKeyHelper|awsAuthRefresh|awsCredentialExport|gcpAuthRefresh|forceLoginMethod)$/u;

const profileSchema = claudeProfileSchema
  .pick({ id: true, label: true })
  .extend({
    location: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("separate") }),
      z.object({
        kind: z.literal("existing"),
        configuration: z.string().nullable(),
        effectiveDirectory: z.string().min(1),
      }),
    ]),
    fingerprint: z.string().nullable(),
  });

const nativeStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string(),
  apiProvider: z.string(),
  email: z.email().nullish(),
  orgId: z.string().min(1).nullish(),
  configDirectory: z.string().min(1),
  loginExpiresAt: z.iso.datetime().nullish(),
});

const settingsSchema = z
  .object({
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

type StoredProfile = z.infer<typeof profileSchema>;

type NativeStatus = z.infer<typeof nativeStatusSchema>;

interface LaunchConfig {
  executable: string;
  env: NodeJS.ProcessEnv;
  profilePath: string;
  configDirectory?: string;
  platformDirectory: string;
}

interface LoginJob {
  state: ClaudeProfileLoginState;
  child: ChildProcess;
}

interface ProfileCheck {
  key: string;
  checkedAt: number;
  profile: ClaudeProfile;
}

interface RootState {
  jobs: Map<string, LoginJob>;
  checks: Map<string, ProfileCheck>;
  pending: Map<string, Promise<ClaudeProfile>>;
}

const stateByRoot = new Map<string, RootState>();

const supportedExecutables = new Map<string, Promise<boolean>>();

function state(root: string): RootState {
  const retained = stateByRoot.get(root);

  if (retained !== undefined) return retained;

  const created: RootState = {
    jobs: new Map(),
    checks: new Map(),
    pending: new Map(),
  };

  stateByRoot.set(root, created);

  return created;
}

function unavailable(message: string): never {
  throw new ExpectedCommandDispatchError("command_failed", message);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function privateDirectory(dir: string, create = false): Promise<void> {
  if (create)
    await fs.mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    });

  const stat = await fs.lstat(dir);

  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    unavailable("Claude account storage is unavailable on this device.");
}

function execute(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<string> {
  return new Promise((done) => {
    execFile(
      executable,
      args,
      { env, cwd, timeout: 6_000, maxBuffer: 32_768 },
      (_error, stdout) => done(stdout),
    );
  });
}

async function nativeExecutable(
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (process.platform !== "darwin" || userInfo().uid !== process.getuid?.())
    return null;

  const userHome = env.HOME ?? homedir();

  const requested =
    env[executableVariable]?.trim() ||
    resolveExecutable("claude", { cwd: userHome, env }) ||
    path.join(userHome, ".local", "bin", "claude");

  if (!requested) return null;

  const real = await fs.realpath(requested).catch(() => null);

  if (real === null) return null;

  const stat = await fs.stat(real).catch(() => null);

  if (stat === null || !stat.isFile()) return null;

  const key = `${real}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  let test = supportedExecutables.get(key);

  if (test === undefined) {
    test = execute(real, ["--version"], env).then((output) =>
      verifiedVersion.test(output),
    );
    supportedExecutables.clear();
    supportedExecutables.set(key, test);
  }

  return (await test) ? real : null;
}

function assertDirectEnv(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    if (value && alternateEnvironment.test(name))
      unavailable(
        `Remove the conflicting Claude setting ${name} or use the ordinary Claude launch.`,
      );
  }
}

async function readNativeStatus(
  config: LaunchConfig,
  cwd?: string,
): Promise<NativeStatus | null> {
  const output = await execute(
    config.executable,
    ["auth", "status", "--json"],
    config.env,
    cwd,
  );

  try {
    return nativeStatusSchema.safeParse(JSON.parse(output)).data ?? null;
  } catch {
    return null;
  }
}

function fingerprint(status: NativeStatus): string | null {
  if (
    !status.loggedIn ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty" ||
    !status.email ||
    !status.orgId
  )
    return null;

  return createHash("sha256")
    .update(JSON.stringify([status.email.toLowerCase(), status.orgId]))
    .digest("hex");
}

function profilePath(root: string, id: string): string {
  return path.join(root, id);
}

async function loadProfile(root: string, id: string): Promise<StoredProfile> {
  const dir = profilePath(root, id);
  await privateDirectory(dir);
  const file = path.join(dir, "profile.json");
  const stat = await fs.lstat(file);

  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    unavailable("Claude account metadata is unavailable.");

  const profile = profileSchema.parse(
    JSON.parse(await fs.readFile(file, "utf8")),
  );

  if (profile.id !== id) unavailable("Claude account metadata does not match.");

  return profile;
}

async function saveProfile(dir: string, profile: StoredProfile): Promise<void> {
  const temporary = path.join(dir, `profile-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(profile), {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporary, path.join(dir, "profile.json"));
}

async function listStoredProfiles(root: string): Promise<StoredProfile[]> {
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });

  if (entries.length > 0) await privateDirectory(root);

  const profiles = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          claudeProfileSchema.shape.id.safeParse(entry.name).success,
      )
      .map(({ name }) =>
        loadProfile(root, name).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        }),
      ),
  );

  return profiles.filter((profile) => profile !== null);
}

function claimProfileIdentity(
  root: string,
  profile: StoredProfile,
  identity: string,
): Promise<"ready" | "wrong-account" | "duplicate-account"> {
  return withFileLock({
    path: path.join(root, ".profile-identities.lock"),
    timeoutMs: 2_000,
    work: async () => {
      const profiles = await listStoredProfiles(root);
      const current = profiles.find(({ id }) => id === profile.id) ?? profile;

      if (current.fingerprint !== null)
        return current.fingerprint === identity ? "ready" : "wrong-account";

      if (profiles.some(({ fingerprint }) => fingerprint === identity))
        return "duplicate-account";

      await saveProfile(profilePath(root, current.id), {
        ...current,
        fingerprint: identity,
      });

      return "ready";
    },
  });
}

function existingSelectionMatches(
  profile: StoredProfile,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    profile.location.kind !== "existing" ||
    profile.location.configuration === (env.CLAUDE_CONFIG_DIR ?? null)
  );
}

async function launchConfig(
  root: string,
  profile: StoredProfile,
  env: NodeJS.ProcessEnv,
  executable: string,
): Promise<LaunchConfig> {
  if (!existingSelectionMatches(profile, env))
    unavailable(
      "The existing Claude configuration changed. Choose a Claude account again.",
    );

  const dir = profilePath(root, profile.id);
  const platformDirectory = path.join(dir, "platform");

  const configDirectory =
    profile.location.kind === "separate" ? path.join(dir, "claude") : undefined;

  await Promise.all([
    privateDirectory(platformDirectory),
    ...(profile.location.kind === "separate" && configDirectory !== undefined
      ? [privateDirectory(configDirectory)]
      : []),
  ]);

  if ((await fs.readdir(platformDirectory)).length !== 0)
    unavailable("The isolated Claude Platform directory is no longer empty.");

  return {
    executable,
    profilePath: dir,
    platformDirectory,
    ...(configDirectory === undefined ? {} : { configDirectory }),
    env: {
      ...env,
      ...(configDirectory === undefined
        ? {}
        : { CLAUDE_CONFIG_DIR: configDirectory }),
      ANTHROPIC_CONFIG_DIR: platformDirectory,
    },
  };
}

function profileInfo(
  profile: StoredProfile,
  status: ClaudeProfile["status"],
  loginExpiresAt: string | null = null,
): ClaudeProfile {
  return { id: profile.id, label: profile.label, status, loginExpiresAt };
}

async function inspectProfile(
  root: string,
  profile: StoredProfile,
  config: LaunchConfig,
  cwd?: string,
): Promise<ClaudeProfile> {
  const native = await readNativeStatus(config, cwd);

  if (native === null) return profileInfo(profile, "unavailable");

  const identity = fingerprint(native);

  if (
    identity === null ||
    (native.loginExpiresAt && Date.parse(native.loginExpiresAt) <= Date.now())
  )
    return profileInfo(
      profile,
      "sign-in-required",
      native.loginExpiresAt ?? null,
    );

  const expectedDir =
    profile.location.kind === "existing"
      ? profile.location.effectiveDirectory
      : config.configDirectory;

  if (
    path.normalize(native.configDirectory) !== path.normalize(expectedDir ?? "")
  )
    return profileInfo(profile, "unavailable");

  if (profile.fingerprint !== null && identity !== profile.fingerprint)
    return profileInfo(profile, "wrong-account");

  if (profile.fingerprint === null) {
    const status = await claimProfileIdentity(root, profile, identity);

    if (status !== "ready") return profileInfo(profile, status);
  }

  return profileInfo(profile, "ready", native.loginExpiresAt ?? null);
}

async function readSettingFingerprint(file: string): Promise<string> {
  const stat = await fs.stat(file).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });

  if (stat === null) return "absent";

  if (!stat.isFile() || stat.size > 256 * 1024)
    unavailable("Claude settings could not be verified for this chat.");

  const source = await fs.readFile(file, "utf8");

  const parsed = (() => {
    try {
      return settingsSchema.safeParse(JSON.parse(source));
    } catch {
      return null;
    }
  })();

  if (!parsed?.success)
    unavailable("Claude settings could not be verified for this chat.");

  for (const key of Object.keys(parsed.data)) {
    if (
      alternateSetting.test(key) &&
      !(key === "forceLoginMethod" && parsed.data[key] === "claudeai")
    )
      unavailable(`The Claude settings include a conflicting ${key}.`);
  }

  for (const name of Object.keys(parsed.data.env ?? {})) {
    if (
      alternateEnvironment.test(name) ||
      name === "CLAUDE_CONFIG_DIR" ||
      name === "ANTHROPIC_CONFIG_DIR" ||
      name === executableVariable
    )
      unavailable(`The Claude settings include a conflicting ${name}.`);
  }

  return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function metadataKey(file: string): Promise<string> {
  const stat = await fs.lstat(file).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });

  return stat === null
    ? "absent"
    : `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

async function checkedProfile(args: {
  root: string;
  stored: StoredProfile;
  config: LaunchConfig;
  cwd?: string;
  force?: boolean;
}): Promise<ClaudeProfile> {
  const { root, stored, config, cwd } = args;

  const configDir =
    config.configDirectory ??
    (stored.location.kind === "existing"
      ? stored.location.effectiveDirectory
      : null);

  if (configDir === null) return profileInfo(stored, "unavailable");

  const projectSettings =
    cwd === undefined
      ? []
      : [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ];

  const [userSettings, credentials, nativeConfig] = await Promise.all([
    readSettingFingerprint(path.join(configDir, "settings.json")),
    metadataKey(path.join(configDir, ".credentials.json")),
    metadataKey(
      path.join(
        stored.location.kind === "existing" &&
          stored.location.configuration === null
          ? (config.env.HOME ?? homedir())
          : configDir,
        ".claude.json",
      ),
    ),
    ...projectSettings.map(readSettingFingerprint),
  ]);

  const key = JSON.stringify([
    stored.fingerprint,
    config.executable,
    userSettings,
    credentials,
    nativeConfig,
  ]);

  const retained = state(root);
  const index = stored.id;
  const current = retained.checks.get(index);
  const now = Date.now();

  if (
    !args.force &&
    current?.key === key &&
    current.profile.status === "ready" &&
    now - current.checkedAt < 60_000 &&
    (current.profile.loginExpiresAt === null ||
      Date.parse(current.profile.loginExpiresAt) > now)
  )
    return current.profile;

  const pendingKey = JSON.stringify([index, key]);
  const pending = retained.pending.get(pendingKey);

  if (pending !== undefined) return pending;

  const operation = inspectProfile(root, stored, config, config.profilePath)
    .then((profile) => {
      retained.checks.set(index, { key, profile, checkedAt: Date.now() });

      return profile;
    })
    .finally(() => retained.pending.delete(pendingKey));

  retained.pending.set(pendingKey, operation);

  return operation;
}

function profileRoot(dataDir: string): string {
  return path.join(dataDir, "native-claude-profiles");
}

function inheritedEnvironment(
  options: CommandDispatchOptions,
): NodeJS.ProcessEnv {
  return { ...process.env, ...options.runtimeManager.getShellEnv() };
}

export async function manageClaudeProfiles(
  request: ClaudeProfileManagementRequest,
  options: CommandDispatchOptions,
): Promise<ClaudeProfileManagementResult> {
  const env = inheritedEnvironment(options);
  const executable = await nativeExecutable(env);

  if (executable === null) {
    if (request.action === "list")
      return { action: "list", supported: false, profiles: [] };
    unavailable("Native Claude accounts are unavailable on this device.");
  }

  const root = profileRoot(options.dataDir);

  if (request.action === "list") {
    const profiles = await Promise.all(
      (await listStoredProfiles(root)).map(async (profile) => {
        try {
          assertDirectEnv(env);
          const config = await launchConfig(root, profile, env, executable);

          return await checkedProfile({ root, stored: profile, config });
        } catch {
          return profileInfo(profile, "unavailable");
        }
      }),
    );

    return { action: "list", supported: true, profiles };
  }

  assertDirectEnv(env);
  await privateDirectory(root, request.action === "add");

  if (request.action === "add") {
    const id = randomUUID();
    const dir = profilePath(root, id);
    await fs.mkdir(dir, { mode: 0o700 });
    const platformDirectory = path.join(dir, "platform");
    await privateDirectory(platformDirectory, true);

    let profile: StoredProfile = {
      id,
      label: request.label,
      location: { kind: "separate" },
      fingerprint: null,
    };

    if (request.adoptExisting) {
      const native = await readNativeStatus({
        executable,
        profilePath: dir,
        platformDirectory,
        env: { ...env, ANTHROPIC_CONFIG_DIR: platformDirectory },
      });

      const identity = native === null ? null : fingerprint(native);

      if (
        identity === null ||
        native === null ||
        (env.CLAUDE_CONFIG_DIR && !path.isAbsolute(env.CLAUDE_CONFIG_DIR))
      )
        unavailable(
          "Sign in to Claude on this device before using the existing login.",
        );
      profile = {
        ...profile,
        location: {
          kind: "existing",
          configuration: env.CLAUDE_CONFIG_DIR ?? null,
          effectiveDirectory: native.configDirectory,
        },
      };
      const status = await claimProfileIdentity(root, profile, identity);

      if (status === "duplicate-account") {
        await fs.rmdir(platformDirectory);
        await fs.rmdir(dir);
        unavailable(duplicateAccountMessage);
      }

      if (status !== "ready")
        unavailable("The Claude account changed during setup. Try again.");
      profile = { ...profile, fingerprint: identity };
    } else {
      await privateDirectory(path.join(dir, "claude"), true);
      await saveProfile(dir, profile);
    }

    const config = await launchConfig(root, profile, env, executable);

    return {
      action: "add",
      profile: await checkedProfile({ root, stored: profile, config }),
    };
  }

  const stored = await loadProfile(root, request.profileId);
  const config = await launchConfig(root, stored, env, executable);
  const retained = state(root);
  const active = retained.jobs.get(stored.id);

  if (request.action === "status")
    return {
      action: "status",
      profile: await checkedProfile({ root, stored, config }),
    };

  if (request.action === "loginCancel" && active?.state === "running") {
    active.state = "idle";
    active.child.kill("SIGTERM");
  }

  if (request.action === "loginStart" && active?.state !== "running") {
    if (
      active !== undefined &&
      active.child.exitCode === null &&
      active.child.signalCode === null
    )
      unavailable("Claude sign-in is still closing. Try again in a moment.");

    if (
      stored.fingerprint !== null &&
      options.runtimeManager.getRuntimeUpdateActivityCount("provider") > 0
    )
      unavailable(
        "Wait for the device's chats to finish before signing in again.",
      );

    const child = spawn(config.executable, ["auth", "login", "--claudeai"], {
      cwd: config.profilePath,
      env: config.env,
      stdio: "ignore",
      timeout: 180_000,
    });

    const job: LoginJob = { state: "running", child };
    retained.jobs.set(stored.id, job);
    retained.checks.clear();
    child.once("error", () => {
      if (job.state === "running") job.state = "failed";
    });
    child.once("exit", (code) => {
      if (job.state === "running")
        job.state = code === 0 ? "finished" : "failed";
      retained.checks.clear();
    });
  }

  const loginState = retained.jobs.get(stored.id)?.state ?? "idle";

  return {
    action: request.action,
    profile:
      loginState === "running"
        ? profileInfo(stored, "sign-in-required")
        : await checkedProfile({
            root,
            stored,
            config,
            force: loginState === "finished",
          }),
    loginState,
  };
}

export async function withClaudeProfileEnvironment(args: {
  options: CommandDispatchOptions;
  context: {
    claudeProfileBinding?: { profileId: string };
    providerId: string;
    contributedEnv: HostDaemonContributedEnvEntry[];
    workspaceContext?: { workspacePath: string };
  };
}): Promise<HostDaemonContributedEnvEntry[]> {
  const { context, options } = args;

  if (context.claudeProfileBinding === undefined) return context.contributedEnv;

  if (context.providerId !== "claude-code")
    unavailable("Native Claude accounts require the Claude provider.");

  const env = inheritedEnvironment(options);
  assertDirectEnv(env);

  for (const entry of context.contributedEnv) {
    if (
      alternateEnvironment.test(entry.name) ||
      [
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_CONFIG_DIR",
        executableVariable,
        "PATH",
        "HOME",
        "XDG_CONFIG_HOME",
      ].includes(entry.name)
    )
      unavailable(`The chat environment includes a conflicting ${entry.name}.`);
  }

  const executable = await nativeExecutable(env);

  if (executable === null)
    unavailable("Native Claude accounts are unavailable on this device.");

  const root = profileRoot(options.dataDir);
  await privateDirectory(root);

  const stored = await loadProfile(
    root,
    context.claudeProfileBinding.profileId,
  );

  if (state(root).jobs.get(stored.id)?.state === "running")
    unavailable(
      "Finish signing in to the selected Claude account and try again.",
    );

  const config = await launchConfig(root, stored, env, executable);

  const status = await checkedProfile({
    root,
    stored,
    config,
    ...(context.workspaceContext === undefined
      ? {}
      : { cwd: context.workspaceContext.workspacePath }),
  });

  if (status.status === "wrong-account")
    unavailable(
      "Claude signed in to a different account. Sign in again with the account this chat uses.",
    );

  if (status.status === "duplicate-account")
    unavailable(duplicateAccountMessage);

  if (status.status !== "ready")
    unavailable("Sign in again to the Claude account this chat uses.");

  const binding = {
    [executableVariable]: executable,
    ...(config.configDirectory === undefined
      ? {}
      : { CLAUDE_CONFIG_DIR: config.configDirectory }),
    ANTHROPIC_CONFIG_DIR: config.platformDirectory,
  };

  return [
    ...context.contributedEnv,
    ...Object.entries(binding).map(
      ([name, value]): HostDaemonContributedEnvEntry => ({
        name,
        value,
        source: { core: "machine-environment" },
        reason: "Selected native Claude account",
      }),
    ),
  ];
}
