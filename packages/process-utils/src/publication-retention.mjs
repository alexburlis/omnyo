import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const sourcePattern = /^[a-f0-9]{40}$/u;

const shaPattern = /^[a-f0-9]{64}$/u;

const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/u;

const absent = (error) => error?.code === "ENOENT";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function physicalDirectory(path) {
  const info = await lstat(path);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error("Publication retention requires physical directories.");
}

export async function withPublicationLock(root, operation) {
  if (!isAbsolute(root) || resolve(root) !== root)
    throw new Error("Publication root must be exact and absolute.");
  await physicalDirectory(root);
  const lock = join(root, ".publication-lock");
  const deadline = Date.now() + 2000;

  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;

      if (Date.now() >= deadline)
        throw new Error(
          "Publication ownership is busy or unresolved; no payload was removed.",
        );
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }

  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true });
  }
}

export async function acquirePublicationReader(root, sourceCommit) {
  if (!sourcePattern.test(sourceCommit))
    throw new Error("Publication reader source is invalid.");
  const path = join(root, ".readers", randomUUID() + ".json");
  await withPublicationLock(root, async () => {
    await physicalDirectory(join(root, sourceCommit));
    await mkdir(join(root, ".readers"), { recursive: true });
    await physicalDirectory(join(root, ".readers"));
    await writeFile(
      path,
      JSON.stringify({
        schema: 1,
        owner: "omnyo-publication-reader",
        sourceCommit,
        pid: process.pid,
      }),
      { flag: "wx", mode: 0o600 },
    );
  });
  let released = false;

  return async () => {
    if (released) return;
    await rm(path);
    released = true;
  };
}

async function jsonFile(path) {
  const info = await lstat(path);

  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
    throw new Error("Publication metadata is invalid.");
  const raw = await readFile(path);

  return { value: JSON.parse(raw), sha256: hash(raw) };
}

async function fileIdentity(path) {
  const before = await lstat(path, { bigint: true });

  if (!before.isFile() || before.isSymbolicLink())
    throw new Error("Publication payload is not a regular file.");
  const digest = createHash("sha256");

  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = await lstat(path, { bigint: true });

  const signature = (entry) =>
    [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(":");

  if (signature(before) !== signature(after))
    throw new Error("Publication payload changed during inspection.");

  return {
    bytes: Number(before.size),
    sha256: digest.digest("hex"),
    identity: signature(before),
  };
}

function manifestValid(manifest) {
  return (
    manifest?.schema === 1 &&
    manifest.approved === true &&
    sourcePattern.test(manifest.sourceCommit) &&
    ["latest", "nightly"].includes(manifest.channel) &&
    Array.isArray(manifest.files) &&
    manifest.files.length > 0 &&
    manifest.files.every(
      (file) =>
        ["macos", "windows"].includes(file.platform) &&
        filenamePattern.test(file.name) &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        shaPattern.test(file.sha256),
    ) &&
    new Set(manifest.files.map((file) => file.platform + "/" + file.name))
      .size === manifest.files.length
  );
}

export async function verifyDesktopPublication(root, manifest) {
  if (!manifestValid(manifest))
    throw new Error("Desktop publication manifest is invalid.");
  await physicalDirectory(join(root, manifest.sourceCommit));

  for (const file of manifest.files) {
    await physicalDirectory(join(root, manifest.sourceCommit, file.platform));

    const identity = await fileIdentity(
      join(root, manifest.sourceCommit, file.platform, file.name),
    );

    if (identity.bytes !== file.size || identity.sha256 !== file.sha256)
      throw new Error(
        "Desktop publication bytes differ from the approved manifest.",
      );
  }
}

async function readerBindings(root) {
  const path = join(root, ".readers");

  const names = await readdir(path).catch((error) => {
    if (absent(error)) return [];
    throw error;
  });

  if (names.length > 0) await physicalDirectory(path);
  const bindings = [];

  for (const name of names.sort()) {
    const read = await jsonFile(join(path, name));
    const value = read.value;

    if (
      value?.schema !== 1 ||
      value.owner !== "omnyo-publication-reader" ||
      !sourcePattern.test(value.sourceCommit) ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0
    )
      throw new Error("Publication reader ownership is unknown.");

    try {
      process.kill(value.pid, 0);
      bindings.push({ name, ...read });
    } catch (error) {
      if (error.code !== "ESRCH") bindings.push({ name, ...read });
    }
  }

  return bindings;
}

async function inspectTree(root, relative = "") {
  const path = relative ? join(root, relative) : root;
  await physicalDirectory(path);
  const records = [];

  for (const name of (await readdir(path)).sort()) {
    const child = relative ? relative + "/" + name : name;
    const info = await lstat(join(root, child));

    if (info.isSymbolicLink())
      throw new Error("Publication tree contains an unknown symbolic link.");

    if (info.isDirectory()) records.push(...(await inspectTree(root, child)));
    else
      records.push({ path: child, ...(await fileIdentity(join(root, child))) });
  }

  return records;
}

function activeReceiptOwner(receipt) {
  if (receipt?.owner == null) return false;

  if (!Number.isSafeInteger(receipt.owner.pid) || receipt.owner.pid <= 0)
    return true;

  try {
    process.kill(receipt.owner.pid, 0);

    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function desktopPlan(root) {
  const bindings = [];
  const keep = new Set();

  for (const name of ["approved.json", "previous-approved.json"]) {
    const record = await jsonFile(join(root, name)).catch((error) => {
      if (absent(error)) return null;
      throw error;
    });

    if (record === null) {
      if (name === "approved.json")
        throw new Error("The approved desktop publication is missing.");
      continue;
    }

    await verifyDesktopPublication(root, record.value);
    keep.add(record.value.sourceCommit);
    bindings.push({ name, sha256: record.sha256 });
  }

  const readers = await readerBindings(root);

  for (const reader of readers) keep.add(reader.value.sourceCommit);
  const recoveryBindings = [];

  for (const sourceCommit of (await readdir(root))
    .filter((name) => sourcePattern.test(name))
    .sort()) {
    const ownership = await jsonFile(
      join(root, sourceCommit, ".publication.json"),
    ).catch((error) => {
      if (absent(error)) return null;
      throw error;
    });

    if (ownership?.value.owner !== "omnyo-desktop-publication") continue;
    const marker = ownership.value;

    if (!Array.isArray(marker.retainedSources)) continue;

    if (
      !marker.retainedSources.every((source) => sourcePattern.test(source)) ||
      !isAbsolute(marker.receiptPath ?? "")
    )
      throw new Error("Desktop publication recovery sources are unknown.");

    const receipt = await jsonFile(marker.receiptPath).catch((error) => {
      if (absent(error)) return null;
      throw error;
    });

    if (
      receipt?.value.status === "complete" &&
      receipt.value.id === marker.jobId &&
      receipt.value.sourceCommit === sourceCommit &&
      !activeReceiptOwner(receipt.value)
    )
      continue;
    keep.add(sourceCommit);

    for (const source of marker.retainedSources) keep.add(source);
    recoveryBindings.push({
      sourceCommit,
      ownershipSha256: ownership.sha256,
      receiptSha256: receipt?.sha256 ?? null,
    });
  }

  const remove = [];
  const held = [];

  for (const sourceCommit of (await readdir(root))
    .filter((name) => sourcePattern.test(name))
    .sort()) {
    if (keep.has(sourceCommit)) {
      held.push({ sourceCommit, reason: "approved, rollback or open reader" });
      continue;
    }

    const path = join(root, sourceCommit);

    const ownership = await jsonFile(join(path, ".publication.json")).catch(
      (error) => {
        if (absent(error)) return null;
        throw error;
      },
    );

    if (ownership === null) {
      held.push({
        sourceCommit,
        reason: "legacy publication has no producer ownership",
      });
      continue;
    }

    const marker = ownership.value;

    if (
      marker?.schema !== 1 ||
      marker.owner !== "omnyo-desktop-publication" ||
      marker.sourceCommit !== sourceCommit ||
      marker.phase !== "verified" ||
      !isAbsolute(marker.receiptPath ?? "") ||
      !manifestValid(marker.manifest) ||
      marker.manifest.sourceCommit !== sourceCommit
    ) {
      held.push({
        sourceCommit,
        reason: "publication ownership or recovery binding is unknown",
      });
      continue;
    }

    const receipt = await jsonFile(marker.receiptPath).catch((error) => {
      if (absent(error)) return null;
      throw error;
    });

    if (
      receipt?.value.status !== "complete" ||
      receipt.value.id !== marker.jobId ||
      receipt.value.sourceCommit !== sourceCommit ||
      activeReceiptOwner(receipt.value)
    ) {
      held.push({
        sourceCommit,
        reason: "publisher job has not closed its recovery inputs",
      });
      continue;
    }

    await verifyDesktopPublication(root, marker.manifest);
    const files = await inspectTree(path);

    const expected = new Set([
      ".publication.json",
      ...marker.manifest.files.map((file) => file.platform + "/" + file.name),
    ]);

    if (
      files.some((file) => !expected.has(file.path)) ||
      files.length !== expected.size
    ) {
      held.push({ sourceCommit, reason: "publication contains unknown files" });
      continue;
    }

    remove.push({
      sourceCommit,
      files,
      receiptSha256: receipt.sha256,
      receiptPath: marker.receiptPath,
    });
  }

  return {
    schema: 1,
    root,
    bindings,
    readers,
    recoveryBindings,
    held,
    remove,
    bytes: remove.reduce(
      (sum, item) =>
        sum + item.files.reduce((total, file) => total + file.bytes, 0),
      0,
    ),
  };
}

export async function planDesktopPublicationRetention(root) {
  return withPublicationLock(root, () => desktopPlan(root));
}

async function saveRetentionJournal(root, journal) {
  const pending = join(root, ".retention-pending-" + randomUUID());

  try {
    await writeFile(pending, JSON.stringify(journal), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(pending, join(root, ".retention.json"));
  } finally {
    await rm(pending, { force: true });
  }
}

export async function applyDesktopPublicationRetention(plan) {
  return withPublicationLock(plan.root, async () => {
    const previous = await jsonFile(join(plan.root, ".retention.json")).catch(
      (error) => {
        if (absent(error)) return null;
        throw error;
      },
    );

    if (
      previous !== null &&
      (previous.value.owner !== "omnyo-desktop-retention" ||
        previous.value.status !== "complete")
    )
      throw new Error(
        "A prior publication retention outcome needs review; its exact journal was preserved.",
      );

    const fresh = await desktopPlan(plan.root);

    if (JSON.stringify(fresh) !== JSON.stringify(plan))
      throw new Error(
        "Publication retention bindings changed; inspect a fresh plan.",
      );

    const journal = {
      schema: 1,
      owner: "omnyo-desktop-retention",
      planSha256: hash(JSON.stringify(plan)),
      plan,
      status: "applying",
      current: null,
      removed: [],
    };

    await saveRetentionJournal(plan.root, journal);

    try {
      for (const item of fresh.remove) {
        journal.current = item.sourceCommit;
        await saveRetentionJournal(plan.root, journal);
        await rm(join(plan.root, item.sourceCommit), { recursive: true });
        journal.removed.push(item.sourceCommit);
        journal.current = null;
        await saveRetentionJournal(plan.root, journal);
      }

      journal.status = "complete";
      await saveRetentionJournal(plan.root, journal);

      return {
        removed: journal.removed,
        bytes: fresh.bytes,
        held: fresh.held,
        journalPath: join(plan.root, ".retention.json"),
      };
    } catch (error) {
      journal.status = "ambiguous";
      await saveRetentionJournal(plan.root, journal);
      throw error;
    }
  });
}

export async function runtimePublicationTreeDigest(root) {
  const records = [];

  async function walk(relative) {
    for (const name of (
      await readdir(relative ? join(root, relative) : root)
    ).sort()) {
      if (!relative && name === ".publication.json") continue;
      const path = relative ? relative + "/" + name : name;
      const entry = await lstat(join(root, path));

      if (entry.isSymbolicLink())
        records.push({ path, link: await readlink(join(root, path)) });
      else if (entry.isDirectory()) {
        records.push({ path, directory: true });
        await walk(path);
      } else if (entry.isFile()) {
        const value = await fileIdentity(join(root, path));
        records.push({ path, bytes: value.bytes, sha256: value.sha256 });
      } else
        throw new Error("Runtime publication contains an unsupported file.");
    }
  }

  await walk("");

  return hash(JSON.stringify(records));
}

export async function assertPublicationStorageBudget(
  root,
  expectedBytes,
  limitBytes,
) {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    !Number.isSafeInteger(limitBytes) ||
    limitBytes <= 0
  )
    throw new Error("Publication storage requires finite positive budgets.");
  let retainedBytes = 0;

  async function walk(path) {
    const entry = await lstat(path);

    if (entry.isSymbolicLink())
      retainedBytes += Math.max(entry.size, entry.blocks * 512);
    else if (entry.isDirectory())
      for (const name of await readdir(path)) await walk(join(path, name));
    else if (entry.isFile()) retainedBytes += entry.size;
    else throw new Error("Publication storage contains an unsupported file.");
  }

  await physicalDirectory(root);
  await walk(root);

  if (
    !Number.isSafeInteger(retainedBytes + expectedBytes) ||
    retainedBytes + expectedBytes > limitBytes
  )
    throw new Error(
      "Publication retention budget is full. Resolve the recorded client, publication or recovery holds before allocating another payload.",
    );

  return { retainedBytes, expectedBytes, limitBytes };
}
