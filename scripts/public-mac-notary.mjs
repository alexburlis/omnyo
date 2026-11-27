import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

const args = process.argv.slice(2);

let stage = "validate-arguments";

const argument = (name) => {
  const index = args.indexOf(name);

  if (index < 0 || !args[index + 1]) throw new Error("notary-argument-missing");

  return args[index + 1];
};

async function digest(path) {
  const hash = createHash("sha256");

  for await (const bytes of createReadStream(path)) hash.update(bytes);

  return hash.digest("hex");
}

async function main() {
  const check = args.includes("--check");
  const signatureOnly = args.includes("--signature-only");
  const app = check ? null : resolve(argument("--app"));
  const archive = check ? null : resolve(argument("--zip"));
  const resultPath = resolve(argument("--result"));
  const job = JSON.parse(await readFile(argument("--job"), "utf8"));
  const tools = job.nativeRelease?.tools ?? {};
  const codesign = tools.codesign ?? "/usr/bin/codesign";
  const xcrun = tools.xcrun ?? "/usr/bin/xcrun";
  const ditto = tools.ditto ?? "/usr/bin/ditto";
  const spctl = tools.spctl ?? "/usr/sbin/spctl";

  const env = Object.fromEntries(
    ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );

  stage = "validate-credentials";

  if (signatureOnly && check) throw new Error("notary-mode-conflict");

  if (
    !signatureOnly &&
    (!process.env.ASC_KEY_ID ||
      !process.env.ASC_ISSUER_ID ||
      !process.env.ASC_PRIVATE_KEY_BASE64)
  )
    throw new Error("notary-credentials-unavailable");

  if (!check) {
    stage = "verify-signature";
    await execute(codesign, ["--verify", "--deep", "--strict", app], {
      env,
      timeout: 60000,
    });

    stage = "verify-signing-team";

    const identity = await execute(codesign, ["-dv", "--verbose=4", app], {
      env,
      timeout: 30000,
    });

    if (!/^TeamIdentifier=Z7T4C33A35$/mu.test(identity.stderr))
      throw new Error("notary-signing-team-differs");
  } else {
    stage = "verify-signing-identity";

    const identities = await execute(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { env, timeout: 30000 },
    );

    if (!identities.stdout.includes("Z7T4C33A35"))
      throw new Error("notary-signing-team-unavailable");
  }

  if (signatureOnly) {
    stage = "write-result";
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          schema: 1,
          status: "complete",
          sourceCommit: job.sourceCommit,
          version: job.version,
          protocolVersion: job.protocolVersion,
          teamId: "Z7T4C33A35",
          notarization: {
            status: "NotRequired",
            reason: "private-feed-installs-are-not-quarantined",
          },
          stapled: false,
          archive: {
            sha256: await digest(archive),
            bytes: (await stat(archive)).size,
          },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );

    return;
  }

  stage = "prepare-notary-key";
  const scratch = await mkdtemp(join(tmpdir(), "omnyo-public-notary-"));
  const key = join(scratch, "key.p8");
  const replacement = join(scratch, "stapled.zip");

  try {
    await writeFile(
      key,
      Buffer.from(process.env.ASC_PRIVATE_KEY_BASE64, "base64"),
      { flag: "wx", mode: 0o600 },
    );

    if (check) {
      stage = "read-notary-history";
      await execute(
        xcrun,
        [
          "notarytool",
          "history",
          "--key",
          key,
          "--key-id",
          process.env.ASC_KEY_ID,
          "--issuer",
          process.env.ASC_ISSUER_ID,
          "--output-format",
          "json",
        ],
        { env, timeout: 60000, maxBuffer: 1024 ** 2 },
      );
      await writeFile(
        resultPath,
        JSON.stringify({
          schema: 1,
          status: "ready",
          teamId: "Z7T4C33A35",
          notaryAvailable: true,
        }) + "\n",
        { mode: 0o600 },
      );

      return;
    }

    stage = "submit-notarization";

    const submitted = await execute(
      xcrun,
      [
        "notarytool",
        "submit",
        archive,
        "--key",
        key,
        "--key-id",
        process.env.ASC_KEY_ID,
        "--issuer",
        process.env.ASC_ISSUER_ID,
        "--wait",
        "--timeout",
        "30m",
        "--output-format",
        "json",
      ],
      { env, timeout: 31 * 60 * 1000, maxBuffer: 1024 ** 2 },
    );

    stage = "validate-notarization-result";
    const notarization = JSON.parse(submitted.stdout);

    if (
      notarization.status !== "Accepted" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate Apple notarytool JSON before accepting its submission.
      typeof notarization.id !== "string"
    )
      throw new Error("notary-not-accepted");
    stage = "staple-ticket";
    await execute(xcrun, ["stapler", "staple", app], { env, timeout: 120000 });
    stage = "validate-ticket";
    await execute(xcrun, ["stapler", "validate", app], { env, timeout: 60000 });
    stage = "assess-gatekeeper";
    await execute(
      spctl,
      ["--assess", "--type", "execute", "--verbose=2", app],
      { env, timeout: 60000 },
    );
    stage = "repack-archive";
    await execute(
      ditto,
      ["-c", "-k", "--sequesterRsrc", "--keepParent", app, replacement],
      { env, timeout: 15 * 60 * 1000 },
    );
    const staged = archive + ".stapled";
    stage = "stage-archive";
    await execute("/bin/cp", ["-pc", replacement, staged], {
      env,
      timeout: 120000,
    });
    stage = "promote-archive";
    await rename(staged, archive);
    stage = "write-result";
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          schema: 1,
          status: "complete",
          sourceCommit: job.sourceCommit,
          version: job.version,
          protocolVersion: job.protocolVersion,
          teamId: "Z7T4C33A35",
          notarization: { id: notarization.id, status: notarization.status },
          stapled: true,
          archive: {
            sha256: await digest(archive),
            bytes: (await stat(archive)).size,
          },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

try {
  await main();
} catch {
  process.stderr.write(
    `Private native notarization failed; no feed was published.\nNotarization stage: ${stage}\n`,
  );
  process.exitCode = 1;
}
