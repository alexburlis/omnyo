import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { z } from "zod";
import { withFileLock, FileLockTimeoutError } from "@omnyo/config/file-lock";
import { createConnectCredentialCache } from "./connect-credential-cache.js";
import {
  assertDesktopProfileOwnedPathV2,
  canonicalDesktopProfilePathV2,
  readDesktopProfileSessionsV2,
} from "./desktop-profile-catalog-v2.mjs";
import {
  DesktopProfileContinuityConsumersActiveError,
  inspectDesktopProfileContinuityJobV2,
  readDesktopProfileContinuityJobV2Sync,
} from "./desktop-profile-adoption-v1.js";
import { transferDesktopProtectedStoreV2 } from "./desktop-protected-store-closed-v2.js";

const execute = promisify(execFile);

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const artifactSchema = z
  .object({
    executable: digest,
    asar: digest,
    framework: digest,
    consumers: digest,
  })
  .strict();

const cookieMetadataSchema = z
  .object({
    count: z.number().int().nonnegative(),
    encrypted: z.number().int().nonnegative(),
    identities: z.array(digest),
    encryptedIdentities: z.array(digest),
  })
  .strict();

const contextSchema = z
  .object({
    key: z.string(),
    source: z.string(),
    target: z.string(),
    sourceCookies: cookieMetadataSchema,
    targetCookies: cookieMetadataSchema,
  })
  .strict();

const requestSchema = z
  .object({
    version: z.literal(2),
    parentPid: z.number().int().positive(),
    bindingSha256: digest,
    journalSha256: digest,
    sourceDigest: digest,
    artifact: artifactSchema,
    contexts: z.array(contextSchema).min(1),
  })
  .strict();

const reportSchema = z
  .object({
    version: z.literal(2),
    processId: z.number().int().positive(),
    requestSha256: digest,
    bindingSha256: digest,
    nativeOwnerSha256: digest,
    protectedStore: z.literal(true),
    cookies: z.literal(true),
    contextCount: z.number().int().positive(),
    cookieCount: z.number().int().nonnegative(),
    encryptedCookieCount: z.number().int().nonnegative(),
    encryptedFileWitness: z.boolean(),
    encryptedCookieWitness: z.boolean(),
    snapshotsSha256: digest,
    interactionNotAllowed: z.literal(true),
    networkServices: z.literal(0),
    windows: z.literal(0),
  })
  .strict()
  .refine(
    (value) => value.encryptedFileWitness || value.encryptedCookieWitness,
  );

const cookieSchema = z
  .object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
  })
  .catchall(z.json());

type Json = z.infer<ReturnType<typeof z.json>>;

function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);

  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );

  return value;
}

export function desktopCookieSnapshotV2(value: unknown) {
  const cookies = z.array(cookieSchema).parse(value);

  return {
    count: cookies.length,
    sha256: sha(
      JSON.stringify(
        cookies.map((cookie) => JSON.stringify(canonical(cookie))).sort(),
      ),
    ),
    nonempty: cookies
      .filter((cookie) => cookie.value.length !== 0)
      .map((cookie) =>
        sha(JSON.stringify([cookie.domain, cookie.name, cookie.path])),
      ),
    identities: cookies
      .map((cookie) =>
        sha(JSON.stringify([cookie.domain, cookie.name, cookie.path])),
      )
      .sort(),
  };
}

async function optionalFile(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
}

export async function inspectDesktopCookieDatabaseV2(
  root: string,
  now: number,
) {
  await assertDesktopProfileOwnedPathV2(root, true);
  const network = join(root, "Network");
  const candidates = [join(root, "Cookies")];

  if (await optionalFile(network)) {
    await assertDesktopProfileOwnedPathV2(network, true);
    candidates.push(join(network, "Cookies"));
  }

  const present: string[] = [];

  for (const path of candidates)
    if (await optionalFile(path)) {
      await assertDesktopProfileOwnedPathV2(path, false);
      present.push(path);
    }

  if (present.length > 1)
    throw new Error("Desktop cookie database locations collide");
  const path = present[0];

  if (path === undefined)
    return { count: 0, encrypted: 0, identities: [], encryptedIdentities: [] };

  const db = new DatabaseSync(path, {
    readOnly: true,
  });

  try {
    const rows = z
      .array(
        z.object({
          host_key: z.string(),
          name: z.string(),
          path: z.string(),
          encrypted: z.number().int().min(0).max(1),
        }),
      )
      .parse(
        db
          .prepare(
            "SELECT host_key, name, path, length(encrypted_value)>0 AS encrypted FROM cookies WHERE has_expires=0 OR expires_utc>?",
          )
          .all(BigInt(Math.floor(now * 1000)) + 11644473600000000n),
      );

    const identities = rows
      .map((row) => sha(JSON.stringify([row.host_key, row.name, row.path])))
      .sort();

    return {
      count: rows.length,
      encrypted: rows.filter((row) => row.encrypted === 1).length,
      identities,
      encryptedIdentities: rows
        .filter((row) => row.encrypted === 1)
        .map((row) => sha(JSON.stringify([row.host_key, row.name, row.path]))),
    };
  } finally {
    db.close();
  }
}

type CookieMetadata = Awaited<
  ReturnType<typeof inspectDesktopCookieDatabaseV2>
>;

export function compareDesktopCookiesV2(
  source: CookieMetadata,
  target: CookieMetadata,
  sourceValue: unknown,
  targetValue: unknown,
) {
  const before = desktopCookieSnapshotV2(sourceValue);
  const after = desktopCookieSnapshotV2(targetValue);

  if (
    JSON.stringify(source) !== JSON.stringify(target) ||
    before.count !== source.count ||
    after.count !== target.count ||
    JSON.stringify(before.identities) !== JSON.stringify(source.identities) ||
    JSON.stringify(after.identities) !== JSON.stringify(target.identities) ||
    before.sha256 !== after.sha256
  )
    throw new Error(
      "Desktop cookie continuity differs from its complete source expectations",
    );

  const counts = new Map<string, { total: number; encrypted: number }>();

  for (const id of source.identities) {
    const prior = counts.get(id);
    counts.set(id, { total: (prior?.total ?? 0) + 1, encrypted: 0 });
  }

  for (const id of source.encryptedIdentities) {
    const entry = counts.get(id);

    if (entry === undefined)
      throw new Error("Desktop encrypted cookie identity is missing");
    entry.encrypted++;
  }

  return {
    count: before.count,
    encrypted: source.encrypted,
    sha256: before.sha256,
    encryptedWitness: before.nonempty.some((id) => {
      const count = counts.get(id);

      return (
        count !== undefined &&
        count.encrypted > 0 &&
        count.encrypted === count.total
      );
    }),
  };
}

export async function inspectDesktopContinuityContextsV2(
  source: string,
  target: string,
) {
  const [before, after] = await Promise.all([
    readDesktopProfileSessionsV2(source),
    readDesktopProfileSessionsV2(target, true),
  ]);

  if (
    JSON.stringify(before.map((entry) => entry.key)) !==
    JSON.stringify(after.map((entry) => entry.key))
  )
    throw new Error("Desktop continuity omitted or changed a source session");
  const now = Date.now();
  const contexts = [];

  for (let offset = 0; offset < before.length; offset += 4) {
    const batch = await Promise.all(
      before.slice(offset, offset + 4).map(async (sourceEntry, index) => {
        const targetEntry = after[offset + index];

        if (targetEntry === undefined)
          throw new Error("Desktop continuity source session is missing");

        const [sourceCookies, targetCookies] = await Promise.all([
          inspectDesktopCookieDatabaseV2(sourceEntry.path, now),
          inspectDesktopCookieDatabaseV2(targetEntry.path, now),
        ]);

        return {
          key: sourceEntry.key,
          source: sourceEntry.path,
          target: targetEntry.path,
          sourceCookies,
          targetCookies,
        };
      }),
    );

    contexts.push(...batch);
  }

  return contexts;
}

export async function verifyDesktopEncryptedFileV2(
  source: string,
  target: string,
  encryption: Parameters<typeof createConnectCredentialCache>[0]["encryption"],
) {
  if (!encryption.isEncryptionAvailable())
    throw new Error("Desktop continuity protected storage is unavailable");

  const paths = [source, target].map((root) =>
    join(root, "connect-credential.bin"),
  );

  const present = await Promise.all(paths.map(optionalFile));

  if (present.every((entry) => entry === null)) return false;

  if (present.some((entry) => entry === null))
    throw new Error("Desktop encrypted source file is missing from a copy");
  await Promise.all(
    paths.map((path) => assertDesktopProfileOwnedPathV2(path, false)),
  );
  const bytes = await Promise.all(paths.map((path) => readFile(path)));

  if (sha(bytes[0] ?? Buffer.alloc(0)) !== sha(bytes[1] ?? Buffer.alloc(0)))
    throw new Error("Desktop encrypted file copies differ");

  const values = await Promise.all(
    [source, target].map((userDataPath) =>
      createConnectCredentialCache({ encryption, userDataPath }).read(),
    ),
  );

  if (values.some((value) => value === null))
    throw new Error("Desktop encrypted source witness is unavailable");

  return true;
}

const canonicalApp = "/Applications/Omnyo.app";

export const desktopContinuityExecutableV2 = join(
  canonicalApp,
  "Contents/MacOS/Omnyo",
);

const resourceRoot = join(canonicalApp, "Contents/Resources");

export const desktopContinuityFencePathV2 = join(
  resourceRoot,
  "app.asar.unpacked/dist/desktop-keychain-ui-fence-v1.node",
);

const consumersPath = join(
  resourceRoot,
  "app.asar.unpacked/dist/desktop-protected-store-consumers-v1.json",
);

async function boundedPrivateJson(path: string, maximum: number) {
  const info = await assertDesktopProfileOwnedPathV2(path, false);

  if ((info.mode & 0o077) !== 0 || info.size > maximum)
    throw new Error(
      "Desktop continuity metadata must remain private and bounded",
    );

  return readFile(path);
}

async function artifact() {
  const paths = [
    desktopContinuityExecutableV2,
    join(resourceRoot, "app.asar"),
    join(
      canonicalApp,
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    ),
    consumersPath,
  ];

  const values = await Promise.all(
    paths.map(async (path) => {
      await assertDesktopProfileOwnedPathV2(path, false);

      return sha(await readFile(path));
    }),
  );

  return artifactSchema.parse({
    executable: values[0],
    asar: values[1],
    framework: values[2],
    consumers: values[3],
  });
}

async function assertProfileLockHeld(jobDir: string) {
  let held = false;

  try {
    await withFileLock({
      path: join(jobDir, "desktop-profile.lock"),
      timeoutMs: 0,
      work: async () => undefined,
    });
  } catch (error) {
    if (!(error instanceof FileLockTimeoutError)) throw error;
    held = true;
  }

  if (!held)
    throw new Error(
      "Desktop continuity requires the existing profile preparation lock",
    );
}

function ownedFileSync(
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
  privateFile = false,
) {
  const info = lstatSync(path);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maximum ||
    realpathSync(path) !== path ||
    (info.mode & 0o022) !== 0 ||
    (privateFile && (info.mode & 0o077) !== 0) ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new Error("Desktop continuity sealed file ownership differs");

  return readFileSync(path);
}

export function readDesktopContinuityPreEntryV2(
  jobDir: string,
  parentPid: number,
) {
  const bytes = ownedFileSync(
    join(jobDir, "desktop-profile-continuity-request-v2.json"),
    1024 * 1024,
    true,
  );

  const request = requestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const context = readDesktopProfileContinuityJobV2Sync(jobDir);

  if (
    request.parentPid !== parentPid ||
    request.journalSha256 !== context.journalSha256 ||
    request.bindingSha256 !== context.bindingSha256 ||
    request.sourceDigest !== context.sourceDigest ||
    request.artifact.executable !==
      context.input.nativeOwner.executableSha256 ||
    sha(ownedFileSync(desktopContinuityExecutableV2)) !==
      request.artifact.executable
  )
    throw new Error(
      "Desktop continuity parent or closed job selection differs",
    );

  const raw = ownedFileSync(consumersPath, 65536);

  if (sha(raw) !== request.artifact.consumers)
    throw new Error("Desktop continuity signed consumer manifest changed");

  const consumers = z
    .object({
      version: z.literal(1),
      desktopProfileAdoptionProtocol: z.literal(2),
      consumers: z
        .array(
          z
            .object({
              file: z.string(),
              identifier: z.string(),
              sha256: digest,
            })
            .passthrough(),
        )
        .length(3),
      qualification: z
        .object({
          selected: z
            .object({
              version: z.literal(1),
              sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
              runtimeVersion: z.literal("0.46.247+private.1"),
              appId: z.literal("dev.omnyo.private"),
              applicationName: z.literal("Omnyo Private"),
              desktopProfileAdoptionProtocol: z.literal(2),
              platform: z.literal("darwin"),
              arch: z.literal("arm64"),
            })
            .strict(),
        })
        .passthrough(),
    })
    .strict()
    .parse(JSON.parse(raw.toString("utf8")));

  const fence = consumers.consumers.find(
    (entry) => entry.file === "desktop-keychain-ui-fence-v1.node",
  );

  const reader = consumers.consumers.find(
    (entry) => entry.file === "desktop-protected-store-reader-v1",
  );

  const writer = consumers.consumers.find(
    (entry) => entry.file === "desktop-protected-store-writer-v1",
  );

  if (
    fence?.identifier !== "dev.omnyo.private.keychain-ui-fence-v1" ||
    reader?.identifier !== "dev.bb.private" ||
    writer?.identifier !== "dev.omnyo.private" ||
    reader.sha256 !== context.input.protectedStoreTransfer.reader.sha256 ||
    writer.sha256 !== context.input.protectedStoreTransfer.writer.sha256 ||
    sha(ownedFileSync(desktopContinuityFencePathV2)) !== fence.sha256
  )
    throw new Error("Desktop continuity native consumer binding differs");
  const keys = new Set<string>();

  for (const entry of request.contexts) {
    if (
      keys.has(entry.key) ||
      (entry.key !== "" &&
        (!/^Partitions\/[^/]+$/u.test(entry.key) ||
          ["Partitions/.", "Partitions/.."].includes(entry.key)))
    )
      throw new Error("Desktop continuity source session selection differs");
    keys.add(entry.key);
    const relativeTarget = entry.target.slice(context.probe.length + 1);

    if (
      entry.source !== join(context.sourceProbe, entry.key) ||
      (entry.key === ""
        ? entry.target !== context.probe
        : !entry.target.startsWith(context.probe + "/") ||
          canonicalDesktopProfilePathV2(relativeTarget, true) !== entry.key ||
          join(context.probe, relativeTarget) !== entry.target)
    )
      throw new Error(
        "Desktop continuity session path escapes its copied owner",
      );

    for (const path of [entry.source, entry.target]) {
      const info = lstatSync(path);

      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(path) !== path ||
        (process.getuid !== undefined && info.uid !== process.getuid())
      )
        throw new Error("Desktop continuity selected session owner differs");
    }
  }

  if (!keys.has(""))
    throw new Error("Desktop continuity default session is missing");

  return { request, context, requestSha256: sha(bytes), consumers };
}

export async function verifyDesktopContinuityArtifactV2(
  jobDir: string,
  expected: z.infer<typeof artifactSchema>,
) {
  await assertProfileLockHeld(jobDir);

  if (JSON.stringify(await artifact()) !== JSON.stringify(expected))
    throw new Error("Desktop continuity installed artifact changed");
}

export async function runDesktopProfileContinuityV2(jobDir: string) {
  const context = await inspectDesktopProfileContinuityJobV2(jobDir);

  const [verified, identity] = await Promise.all([
    execute(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", canonicalApp],
      { timeout: 15000, maxBuffer: 8192 },
    ),
    execute("/usr/bin/codesign", ["-d", "--verbose=4", canonicalApp], {
      timeout: 3000,
      maxBuffer: 8192,
    }),
  ]);

  if (
    verified.stderr.length > 8192 ||
    !identity.stderr.split("\n").includes("Identifier=dev.omnyo.private") ||
    !identity.stderr.split("\n").includes("TeamIdentifier=Z7T4C33A35")
  )
    throw new Error("Desktop continuity installed signing identity differs");
  const selectedArtifact = await artifact();

  if (
    selectedArtifact.executable !== context.input.nativeOwner.executableSha256
  )
    throw new Error(
      "Desktop continuity executable differs from its attested native owner",
    );

  const contexts = await inspectDesktopContinuityContextsV2(
    context.sourceProbe,
    context.probe,
  );

  const request = requestSchema.parse({
    version: 2,
    parentPid: process.pid,
    bindingSha256: context.bindingSha256,
    journalSha256: context.journalSha256,
    sourceDigest: context.sourceDigest,
    artifact: selectedArtifact,
    contexts,
  });

  const requestPath = join(
    jobDir,
    "desktop-profile-continuity-request-v2.json",
  );

  const reportPath = join(jobDir, "desktop-profile-continuity-report-v2.json");

  if (await optionalFile(reportPath))
    throw new Error(
      "Desktop continuity report requires explicit owned reconciliation",
    );
  const handle = await open(requestPath, "wx", 0o600);
  const bytes = JSON.stringify(request) + "\n";

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  readDesktopContinuityPreEntryV2(jobDir, process.pid);

  const status = await transferDesktopProtectedStoreV2(
    context.protectedStoreBinding,
    "status",
  );

  if (status.outcome !== "closed" || status.admitted)
    throw new Error("Desktop continuity native admission is not closed");

  const child = spawn(
    desktopContinuityExecutableV2,
    ["--omnyo-profile-continuity-v2", jobDir],
    {
      timeout: 4000,
      killSignal: "SIGTERM",
      detached: true,
      stdio: "ignore",
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR,
      },
    },
  );

  let exitCode: number | null;

  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("Desktop continuity process could not start")),
      );
      child.once("close", (code) => resolve(code));
    });
  } finally {
    const pid = child.pid;

    if (pid === undefined)
      throw new DesktopProfileContinuityConsumersActiveError(
        "Desktop continuity child identity is uncertain; copied probes were preserved",
      );
    let stopped = false;

    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        stopped = true;
      else
        throw new DesktopProfileContinuityConsumersActiveError(
          "Desktop continuity child ownership is uncertain; copied probes were preserved",
        );
    }

    if (!stopped)
      throw new DesktopProfileContinuityConsumersActiveError(
        "Desktop continuity consumers remain active; copied probes were preserved",
      );
  }

  if (exitCode !== 0)
    throw new Error(
      "Desktop continuity process did not verify its copied profile",
    );

  const report = reportSchema.parse(
    JSON.parse((await boundedPrivateJson(reportPath, 16384)).toString("utf8")),
  );

  if (
    report.processId !== child.pid ||
    report.requestSha256 !== sha(bytes) ||
    report.bindingSha256 !== context.bindingSha256 ||
    report.nativeOwnerSha256 !== context.nativeOwnerSha256 ||
    (await realpath(desktopContinuityExecutableV2)) !==
      desktopContinuityExecutableV2 ||
    JSON.stringify(await artifact()) !== JSON.stringify(selectedArtifact)
  )
    throw new Error("Desktop continuity result or artifact changed");

  return {
    protectedStore: report.protectedStore,
    cookies: report.cookies,
    nativeOwnerSha256: report.nativeOwnerSha256,
  };
}

export const desktopContinuityReportSchemaV2 = reportSchema;
