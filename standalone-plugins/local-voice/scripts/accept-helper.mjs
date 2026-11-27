import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const built = fileURLToPath(new URL("../helper/bin/OmnyoLocalVoice", import.meta.url));

const accepted = fileURLToPath(new URL("../native/OmnyoLocalVoice", import.meta.url));

const temporary = `${accepted}.partial`;

function run(command, args, failure) {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 30_000 });

  if (result.status !== 0) throw new Error(failure);
}

await mkdir(dirname(accepted), { recursive: true });

try {
  await copyFile(built, temporary);
  run(
    "/usr/bin/strip",
    ["-S", temporary],
    "Stripping debug symbols from the Dictation by Paraspeech helper failed.",
  );
  run(
    "/usr/bin/codesign",
    ["--force", "--sign", "-", temporary],
    "Signing the Dictation by Paraspeech helper failed.",
  );
  run(
    "/usr/bin/codesign",
    ["--verify", "--strict", temporary],
    "The Dictation by Paraspeech helper signature is invalid.",
  );

  if ((await readFile(temporary)).includes(homedir()))
    throw new Error("The Dictation by Paraspeech helper embeds this machine's home folder.");
  await chmod(temporary, 0o755);
  await rename(temporary, accepted);
} finally {
  await rm(temporary, { force: true });
}
