import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  brandedCandidates,
  createSymbolResolver,
  isScript,
  selectEdits,
} from "./omnyo-rename/selectors.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".turbo",
  "dist",
  "build",
]);

const preservedClasses = new Set([
  "required-license-and-original-copyright",
  "real-upstream-reference",
  "third-party-identity",
  "immutable-history-or-applied-migration",
  "opaque-checksum-encoded-bytes-or-user-content",
  "narrow-versioned-legacy-input",
]);

const slash = (file) => file.split(sep).join("/");

const pathKey = (file) => file.normalize("NFC").toLowerCase();

function protectedPath(file) {
  return (
    file
      .split("/")
      .some((part) => part === ".env" || part.startsWith(".env.")) ||
    /\.(?:pem|key|p12|pfx|1p|db|sqlite|sqlite3)$/i.test(file)
  );
}

function safePath(root, file, allowMissing = false, measureProtected = false) {
  if (
    typeof file !== "string" ||
    !file ||
    isAbsolute(file) ||
    file.includes("\\") ||
    file.includes("\0") ||
    file.split("/").some((part) => part === ".." || part === "." || !part) ||
    file.length > 240
  )
    throw new Error("unsafe candidate path");
  const absolute = resolve(root, file);

  if (!absolute.startsWith(`${root}${sep}`))
    throw new Error("unsafe candidate escape");
  let cursor = root;

  for (const part of file.split("/")) {
    cursor = join(cursor, part);

    if (!existsSync(cursor)) {
      if (!allowMissing) throw new Error(`Missing input ${file}`);
      continue;
    }

    if (lstatSync(cursor).isSymbolicLink())
      throw new Error(`symlink traversal refused at ${file}`);
  }

  if (
    file
      .split("/")
      .some((part) => part === ".git" || part === "node_modules") ||
    (!measureProtected && protectedPath(file))
  )
    throw new Error(`Protected input refused at ${file}`);

  return absolute;
}

function gitBinding(root) {
  try {
    const options = {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 20 * 1024 * 1024,
    };

    const head = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    const index = execFileSync("git", ["ls-files", "--stage", "-z"], options);

    return { head, index_digest: hash(index) };
  } catch {
    return null;
  }
}

function enumerate(root) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();

    if (realpathSync(top) === root)
      return [
        ...new Set(
          execFileSync(
            "git",
            ["ls-files", "-c", "-o", "--exclude-standard", "-z"],
            {
              cwd: root,
              encoding: "utf8",
              timeout: 5000,
              maxBuffer: 20 * 1024 * 1024,
            },
          )
            .split("\0")
            .filter(Boolean)
            .filter((file) => {
              try {
                lstatSync(resolve(root, file));

                return true;
              } catch (error) {
                if (error.code === "ENOENT") return false;
                throw error;
              }
            }),
        ),
      ].sort();
  } catch {}

  const paths = [];

  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) continue;
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) walk(join(directory, entry.name), file);
      else paths.push(file);
    }
  };

  walk(root, "");

  return paths.sort();
}

function digestFile(file) {
  return existsSync(file) ? hash(readFileSync(file)) : null;
}

function overlap(a, b) {
  return a.start < b.start + b.length && b.start < a.start + a.length;
}

function transform(text, edits) {
  let output = text;

  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (output.slice(edit.start, edit.start + edit.length) !== edit.before)
      throw new Error("Bound edit changed before transformation");
    output =
      output.slice(0, edit.start) +
      edit.after +
      output.slice(edit.start + edit.length);
  }

  return output;
}

function pathTarget(file, rules) {
  const selected = rules
    .filter((rule) => file === rule.file || file.startsWith(`${rule.file}/`))
    .sort((a, b) => b.file.length - a.file.length);

  if (!selected.length) return file;
  let target = selected[0].target + file.slice(selected[0].file.length);

  for (const parent of selected.slice(1))
    if (target === parent.file || target.startsWith(`${parent.file}/`))
      target = parent.target + target.slice(parent.file.length);

  return target;
}

function addConflict(conflicts, operation, message) {
  conflicts.push({
    operation: operation?.id ?? null,
    file: operation?.selector?.file ?? null,
    message,
  });
}

function preservationRanges(text, selector) {
  if (!preservedClasses.has(selector.reason))
    throw new Error("Preservation requires an exact approved reason");

  if (
    selector.reason === "narrow-versioned-legacy-input" &&
    (!selector.input_version || !selector.removal_condition)
  )
    throw new Error(
      "Legacy preservation requires version and removal condition",
    );

  if (selector.wholeFile === true) {
    if (!selector.digest || hash(text) !== selector.digest)
      throw new Error("Whole-file preservation requires its exact digest");

    return [{ start: 0, length: text.length }];
  }

  if (typeof selector.before !== "string" || !selector.before.length)
    throw new Error("Preservation requires an exact token context");

  if (selector.start !== undefined) {
    if (
      text.slice(selector.start, selector.start + selector.before.length) !==
      selector.before
    )
      throw new Error("Preserve no match");

    return [{ start: selector.start, length: selector.before.length }];
  }

  const ranges = [];
  let start = text.indexOf(selector.before);

  while (start !== -1) {
    ranges.push({ start, length: selector.before.length });
    start = text.indexOf(selector.before, start + selector.before.length);
  }

  if (!ranges.length) throw new Error("Preserve no match");

  return ranges;
}

function validateOperation(operation) {
  if (
    !operation?.id ||
    !operation.rule_id ||
    !operation.owner ||
    !Array.isArray(operation.ledger_ids) ||
    !operation.ledger_ids.length ||
    !Array.isArray(operation.proof_ids) ||
    !operation.proof_ids.length ||
    !Array.isArray(operation.migration_ids) ||
    !operation.selector
  )
    throw new Error(
      "Operation lacks required ownership/rule/ledger/proof/migration fields",
    );

  if (operation.disposition === "blocked")
    throw new Error("Operation has an unresolved external gate");
}

export function createRenamePlan({ root, manifest }) {
  root = realpathSync(root);
  const conflicts = [];
  const owner = manifest.candidate?.owner;

  if (Array.isArray(manifest.refusals) && manifest.refusals.length)
    addConflict(
      conflicts,
      null,
      "Source mapping contains unresolved semantic refusals",
    );

  if (
    !owner ||
    (manifest.candidate?.root && realpathSync(manifest.candidate.root)) !== root
  )
    addConflict(conflicts, null, "Candidate ownership/root is not bound");
  const files = enumerate(root);
  const universe = [];
  const contents = new Map();

  for (const file of files) {
    try {
      const absolute = safePath(root, file, false, true);
      const bytes = readFileSync(absolute);

      const readable =
        !protectedPath(file) &&
        !bytes.includes(0) &&
        Buffer.from(bytes.toString("utf8")).equals(bytes);

      universe.push({
        path: file,
        digest: hash(bytes),
        mode: statSync(absolute).mode & 0o777,
        size: bytes.length,
        format: protectedPath(file)
          ? "protected"
          : readable
            ? "text"
            : "opaque",
      });

      if (readable) contents.set(file, bytes.toString("utf8"));
    } catch (error) {
      addConflict(conflicts, { selector: { file } }, error.message);
    }
  }

  const universeByPath = new Map(universe.map((entry) => [entry.path, entry]));
  const validatedPaths = new Set();
  const operations = manifest.operations ?? [];
  const ids = new Set();
  const valid = [];

  for (const operation of operations) {
    try {
      validateOperation(operation);

      if (ids.has(operation.id))
        throw new Error("Duplicate operation identity");
      ids.add(operation.id);
      const validationKey = `${operation.selector.kind === "defer"}:${operation.selector.file}`;

      if (!validatedPaths.has(validationKey)) {
        safePath(
          root,
          operation.selector.file,
          false,
          operation.selector.kind === "defer",
        );
        validatedPaths.add(validationKey);
      }

      valid.push(operation);
    } catch (error) {
      addConflict(conflicts, operation, error.message);
    }
  }

  const preserved = [];
  const deferred = [];
  const deferredByFile = new Map();
  const edits = new Map();
  const pathRules = [];

  for (const operation of valid.filter(
    (op) => op.selector.kind === "preserve",
  )) {
    try {
      const text = contents.get(operation.selector.file);

      if (text === undefined) {
        const entry = universeByPath.get(operation.selector.file);

        if (
          !operation.selector.wholeFile ||
          operation.selector.digest !== entry?.digest ||
          !preservedClasses.has(operation.selector.reason)
        )
          throw new Error(
            "Opaque preservation requires its exact digest and reason",
          );
        preserved.push({
          file: entry.path,
          start: 0,
          length: entry.size,
          operation_id: operation.id,
          reason: operation.selector.reason,
          opaque: true,
        });
        continue;
      }

      for (const range of preservationRanges(text, operation.selector))
        preserved.push({
          file: operation.selector.file,
          ...range,
          operation_id: operation.id,
          reason: operation.selector.reason,
          input_version: operation.selector.input_version,
          removal_condition: operation.selector.removal_condition,
        });
    } catch (error) {
      addConflict(conflicts, operation, error.message);
    }
  }

  let resolver;

  try {
    for (const operation of valid.filter(
      (op) => op.selector.kind !== "preserve",
    )) {
      try {
        const selector = operation.selector;

        if (selector.kind === "defer") {
          const entry = universeByPath.get(selector.file);

          if (
            !entry ||
            selector.digest !== entry.digest ||
            typeof selector.phase !== "string" ||
            !/^P[0-7]$/.test(selector.phase) ||
            typeof selector.reason !== "string" ||
            !selector.reason.trim()
          )
            throw new Error(
              "Deferral requires the exact input digest, later phase and reason",
            );

          const ranged =
            selector.start !== undefined || selector.length !== undefined;

          if (
            ranged &&
            (!Number.isSafeInteger(selector.start) ||
              selector.start < 0 ||
              !Number.isSafeInteger(selector.length) ||
              selector.length < 1 ||
              selector.start + selector.length >
                (contents.get(selector.file)?.length ?? 0))
          )
            throw new Error(
              "Range deferral requires a nonempty exact text range",
            );

          if (selector.pathOnly === true && ranged)
            throw new Error("Path deferral cannot cover text ranges");

          if (
            (deferredByFile.get(selector.file) ?? []).some(
              (file) =>
                file.file === selector.file &&
                (selector.pathOnly === true
                  ? file.path_only || file.start === undefined
                  : !ranged
                    ? !file.path_only
                    : !file.path_only &&
                      (file.start === undefined || overlap(file, selector))),
            )
          )
            throw new Error("Duplicate or overlapping file deferral");

          const pending = {
            file: selector.file,
            input_digest: entry.digest,
            owner: operation.owner,
            phase: selector.phase,
            reason: selector.reason,
            operation_id: operation.id,
            ...(ranged
              ? { start: selector.start, length: selector.length }
              : selector.pathOnly === true
                ? { path_only: true }
                : {}),
          };

          deferred.push(pending);
          const previousDeferred = deferredByFile.get(selector.file) ?? [];
          previousDeferred.push(pending);
          deferredByFile.set(selector.file, previousDeferred);
          continue;
        }

        if (selector.kind === "path") {
          safePath(root, selector.target, true);
          pathRules.push(selector);
          continue;
        }

        if (selector.kind === "generatedOwner")
          throw new Error(
            "Generated output must be rebuilt and verified through its declared owner",
          );
        const text = contents.get(selector.file);

        if (text === undefined)
          throw new Error("Selector input is not owned text");

        if (selector.kind === "symbol")
          resolver ??= createSymbolResolver(root, files, contents);

        const selected =
          selector.kind === "symbol"
            ? resolver.resolve(selector)
            : selectEdits(root, selector.file, text, selector).map((edit) => ({
                file: selector.file,
                ...edit,
              }));

        if (!selected.length) throw new Error("Selector no match");

        if (selector.count !== undefined && selected.length !== selector.count)
          throw new Error("Selector match count differs");

        for (const item of selected) {
          if (item.serialized && !operation.migration_ids.length)
            throw new Error("Serialized edit requires a migration ID");

          if (
            preserved.some(
              (entry) => entry.file === item.file && overlap(entry, item),
            )
          )
            throw new Error("Selected edit overlaps preservation");
          const previous = edits.get(item.file) ?? [];

          if (previous.some((entry) => overlap(entry, item)))
            throw new Error("Overlapping selectors refused");

          if (
            item.jsonKey &&
            previous.some(
              (entry) =>
                entry.jsonParent === item.jsonParent &&
                entry.jsonKey === item.jsonKey,
            )
          )
            throw new Error("JSON target key collision");
          previous.push({
            ...item,
            operation_id: operation.id,
            rule_id: operation.rule_id,
            ledger_ids: operation.ledger_ids,
            migration_ids: operation.migration_ids,
            proof_ids: operation.proof_ids,
            owner: operation.owner,
          });
          edits.set(item.file, previous);
        }
      } catch (error) {
        addConflict(conflicts, operation, error.message);
      }
    }
  } finally {
    resolver?.dispose();
  }

  const outputFiles = [];
  const targets = new Map();

  for (const entry of universe) {
    try {
      const target = pathTarget(entry.path, pathRules);
      safePath(
        root,
        target,
        true,
        target === entry.path && !edits.has(entry.path),
      );
      const key = pathKey(target);

      if (
        target !== entry.path &&
        existsSync(resolve(root, target)) &&
        !universe.some((input) => input.path === target) &&
        !sameFile(resolve(root, target), resolve(root, entry.path))
      )
        throw new Error(
          "Target path collision with an unowned or ignored file",
        );

      if (targets.has(key))
        throw new Error(`Target path collision with ${targets.get(key)}`);
      targets.set(key, entry.path);
      const selected = edits.get(entry.path) ?? [];

      if (
        (deferredByFile.get(entry.path) ?? []).some(
          (file) =>
            target !== entry.path ||
            (!file.path_only &&
              (file.start === undefined
                ? selected.length > 0
                : selected.some((edit) => overlap(file, edit)))),
        )
      )
        throw new Error(
          "Deferred file or range cannot receive overlapping edits or path moves",
        );

      if (target !== entry.path || selected.length) {
        const afterDigest = selected.length
          ? hash(transform(contents.get(entry.path), selected))
          : entry.digest;

        outputFiles.push({
          input_path: entry.path,
          target_path: target,
          input_digest: entry.digest,
          output_digest: afterDigest,
          mode: entry.mode,
          edits: selected,
        });
      }
    } catch (error) {
      addConflict(conflicts, { selector: { file: entry.path } }, error.message);
    }
  }

  const unresolved = [];
  const deferredCandidates = [];

  for (const [file, text] of contents) {
    const wholeFilePending = (deferredByFile.get(file) ?? []).find(
      (entry) => entry.start === undefined && !entry.path_only,
    );

    if (wholeFilePending) {
      deferredCandidates.push({
        file,
        context: "whole-file-pending",
        input_digest: wholeFilePending.input_digest,
      });
      continue;
    }

    let candidates;

    try {
      candidates = brandedCandidates(file, text);
    } catch {
      candidates = [{ start: 0, length: text.length, context: "unparsed" }];
    }

    const ranges = [
      ...(edits.get(file) ?? []),
      ...preserved.filter((entry) => entry.file === file),
    ];

    for (const candidate of candidates)
      if (
        !ranges.some(
          (entry) =>
            candidate.start >= entry.start &&
            candidate.start + candidate.length <= entry.start + entry.length,
        )
      )
        ((deferredByFile.get(file) ?? []).some(
          (entry) =>
            !entry.path_only &&
            (entry.start === undefined ||
              (candidate.start >= entry.start &&
                candidate.start + candidate.length <=
                  entry.start + entry.length)),
        )
          ? deferredCandidates
          : unresolved
        ).push({ file, ...candidate });
  }

  for (const entry of universe)
    if (
      entry.format === "protected" &&
      !(deferredByFile.get(entry.path) ?? []).some(
        (file) => file.start === undefined && !file.path_only,
      )
    )
      unresolved.push({
        file: entry.path,
        context: "protected-owner",
        start: 0,
        length: entry.size,
      });

  for (const entry of universe)
    if (
      /(?:^|\/)bb(?:[.-]|\/|$)/i.test(entry.path) &&
      pathTarget(entry.path, pathRules) === entry.path &&
      !preserved.some(
        (item) =>
          item.file === entry.path &&
          item.start === 0 &&
          item.length === entry.size,
      )
    )
      ((deferredByFile.get(entry.path) ?? []).some(
        (file) => file.path_only || file.start === undefined,
      )
        ? deferredCandidates
        : unresolved
      ).push({ file: entry.path, context: "path" });

  const base = {
    schema: 1,
    source_root: root,
    source_revision: gitBinding(root),
    owner,
    universe,
    files: outputFiles,
    preservations: preserved,
    deferred,
    deferred_candidates: deferredCandidates,
    unresolved,
    conflicts,
  };

  return { ...base, digest: hash(JSON.stringify(base)) };
}

function fsyncDirectory(directory) {
  const fd = openSync(directory, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableWrite(file, bytes, mode = 0o600) {
  const pending = `${file}.pending`;

  if (existsSync(pending))
    throw new Error(`Unreconciled pending write at ${pending}`);
  const fd = openSync(pending, "wx", mode);

  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  renameSync(pending, file);
  fsyncDirectory(dirname(file));
}

function validatePlan(root, plan) {
  const { digest, ...base } = plan;

  if (digest !== hash(JSON.stringify(base)))
    throw new Error("Plan digest differs");

  if (plan.schema !== 1 || plan.source_root !== root || !plan.owner)
    throw new Error("Plan is not bound to this owned candidate");

  if (JSON.stringify(plan.source_revision) !== JSON.stringify(gitBinding(root)))
    throw new Error("Source revision/index drift");

  if (plan.conflicts.length || plan.unresolved.length)
    throw new Error("Plan has conflicts or unresolved candidates");

  for (const file of plan.files) {
    safePath(root, file.input_path, true);
    safePath(root, file.target_path, true);
  }
}

function stagePath(staging, index) {
  return join(staging, `${index}.source`);
}

function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const first = statSync(a);
  const second = statSync(b);

  return first.dev === second.dev && first.ino === second.ino;
}

function validateCurrent(root, plan, staging, allowAfter) {
  const byInput = new Map(
    plan.files.map((entry, index) => [entry.input_path, { ...entry, index }]),
  );

  const expectedPaths = new Set(plan.universe.map((entry) => entry.path));

  for (const entry of plan.files) expectedPaths.add(entry.target_path);

  for (const file of enumerate(root))
    if (!expectedPaths.has(file))
      throw new Error(`Source universe drift at ${file}`);

  for (const entry of plan.universe) {
    const operation = byInput.get(entry.path);

    if (!operation) {
      if (
        digestFile(safePath(root, entry.path, true, true)) !== entry.digest ||
        (statSync(resolve(root, entry.path)).mode & 0o777) !== entry.mode
      )
        throw new Error(`Source drift at ${entry.path}`);
      continue;
    }

    const input = safePath(root, operation.input_path, true);
    const target = safePath(root, operation.target_path, true);
    const stage = stagePath(staging, operation.index);
    const present = [];

    for (const candidate of new Set([input, target, stage])) {
      if (!existsSync(candidate)) continue;

      if (lstatSync(candidate).isSymbolicLink())
        throw new Error(`Staging symlink refused at ${operation.input_path}`);

      if (!present.some((current) => sameFile(candidate, current)))
        present.push(candidate);
    }

    if (present.length !== 1)
      throw new Error(
        `Ambiguous source/staging drift at ${operation.input_path}`,
      );
    const current = digestFile(present[0]);

    if (
      (sameFile(present[0], input) && current === operation.input_digest) ||
      (allowAfter &&
        sameFile(present[0], target) &&
        current === operation.output_digest) ||
      (allowAfter &&
        present[0] === stage &&
        (current === operation.input_digest ||
          current === operation.output_digest))
    )
      continue;
    throw new Error(`Source digest drift at ${operation.input_path}`);
  }
}

export function applyRenamePlan({
  root,
  plan,
  journalPath,
  resume = false,
  fault = () => {},
}) {
  root = realpathSync(root);
  validatePlan(root, plan);
  journalPath = resolve(journalPath);

  if (journalPath.startsWith(`${root}${sep}`) || !isAbsolute(journalPath))
    throw new Error("Journal must be outside the candidate source");
  const staging = `${journalPath}.staging`;
  const existing = existsSync(journalPath);

  if (resume && !existing)
    throw new Error("Resume requires the original durable journal");

  if (existing) {
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));

    if (
      journal.plan_digest !== plan.digest ||
      journal.source_root !== root ||
      journal.owner !== plan.owner
    )
      throw new Error("Journal ownership or plan differs");
  } else if (existsSync(staging))
    throw new Error("Unowned staging directory exists");
  validateCurrent(root, plan, staging, existing);

  const record = (phase) =>
    durableWrite(
      journalPath,
      `${JSON.stringify({ schema: 1, source_root: root, owner: plan.owner, plan_digest: plan.digest, phase }, null, 2)}\n`,
    );

  if (!existing) record("prepared");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  record("staging");

  for (const [index, file] of plan.files.entries()) {
    const source = safePath(root, file.input_path, true);
    const target = safePath(root, file.target_path, true);
    const stage = stagePath(staging, index);

    if (
      digestFile(target) === file.output_digest &&
      readdirSync(dirname(target)).includes(basename(target)) &&
      (!existsSync(source) || sameFile(source, target))
    )
      continue;

    if (!existsSync(stage)) {
      renameSync(source, stage);
      fsyncDirectory(dirname(source));
      fsyncDirectory(staging);
      fault("after-stage", file);
    }

    if (
      digestFile(stage) === file.input_digest &&
      file.input_digest !== file.output_digest
    ) {
      durableWrite(
        stage,
        transform(readFileSync(stage, "utf8"), file.edits),
        file.mode,
      );
      fault("after-edit", file);
    }
  }

  record("publishing");

  for (const [index, file] of plan.files.entries()) {
    const target = safePath(root, file.target_path, true);
    const stage = stagePath(staging, index);

    if (!existsSync(stage)) continue;

    if (existsSync(target))
      throw new Error(`Target collision before publish at ${file.target_path}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(stage, target);
    fsyncDirectory(dirname(target));
    fault("after-publish", file);
  }

  record("complete");
  rmdirSync(staging);

  for (const file of plan.files) {
    if (file.input_path === file.target_path) continue;
    let directory = dirname(resolve(root, file.input_path));

    while (
      directory !== root &&
      directory.startsWith(`${root}${sep}`) &&
      existsSync(directory) &&
      !readdirSync(directory).length
    ) {
      rmdirSync(directory);
      directory = dirname(directory);
    }
  }

  return { ok: true, plan_digest: plan.digest, files: plan.files.length };
}

export function checkRenamePlan({ root, plan }) {
  root = realpathSync(root);
  validatePlan(root, plan);
  const conflicts = [];

  const expected = new Map(
    plan.universe.map((file) => [file.path, file.digest]),
  );

  for (const file of plan.files) {
    expected.delete(file.input_path);
    expected.set(file.target_path, file.output_digest);
  }

  const currentFiles = enumerate(root);
  const byTarget = new Map(plan.files.map((file) => [file.target_path, file]));
  const unresolved = [];

  for (const file of currentFiles) {
    const operation = byTarget.get(file);
    const original = operation?.input_path ?? file;
    let bytes;

    try {
      bytes = readFileSync(safePath(root, file));
    } catch {
      continue;
    }

    const entry = plan.universe.find((input) => input.path === original);

    if (entry?.format !== "text") continue;
    const text = bytes.toString("utf8");
    let candidates;

    try {
      candidates = brandedCandidates(file, text);
    } catch {
      candidates = [{ start: 0, length: text.length, context: "unparsed" }];
    }

    const ranges = plan.preservations
      .filter((preserved) => preserved.file === original)
      .map((preserved) => ({
        ...preserved,
        start:
          preserved.start +
          (operation?.edits ?? [])
            .filter((edit) => edit.start + edit.length <= preserved.start)
            .reduce((sum, edit) => sum + edit.after.length - edit.length, 0),
      }));

    for (const candidate of candidates)
      if (
        !ranges.some(
          (range) =>
            candidate.start >= range.start &&
            candidate.start < range.start + range.length,
        )
      )
        unresolved.push({ file, ...candidate });
  }

  for (const file of currentFiles)
    if (!expected.has(file))
      conflicts.push({ file, message: "Unexpected output path" });

  for (const [file, digest] of expected) {
    try {
      if (
        digestFile(safePath(root, file, true, !byTarget.has(file))) !== digest
      )
        conflicts.push({ file, message: "Output digest differs" });
    } catch (error) {
      conflicts.push({ file, message: error.message });
    }
  }

  return {
    ok:
      conflicts.length === 0 &&
      unresolved.length === 0 &&
      plan.deferred.length === 0,
    plan_digest: plan.digest,
    files: currentFiles.length,
    conflicts,
    unresolved,
    deferred: plan.deferred,
  };
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const options = new Map();

  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith("--") || !args[i + 1])
      throw new Error("Expected named option and value");
    options.set(args[i].slice(2), args[i + 1]);
  }

  const root = resolve(options.get("root") ?? process.cwd());

  const read = (key) => {
    const file = options.get(key);

    if (!file) throw new Error(`Missing --${key}`);

    return JSON.parse(readFileSync(file, "utf8"));
  };

  let result;

  if (command === "plan")
    result = createRenamePlan({ root, manifest: read("manifest") });
  else if (command === "apply" || command === "resume")
    result = applyRenamePlan({
      root,
      plan: read("plan"),
      journalPath: options.get("journal") ?? "",
      resume: command === "resume",
    });
  else if (command === "check")
    result = checkRenamePlan({ root, plan: read("plan") });
  else throw new Error("Use plan, apply, resume or check");
  const output = options.get("output");

  if (output)
    durableWrite(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ command, ok: result.ok ?? (!result.conflicts.length && !result.unresolved.length), digest: result.digest ?? result.plan_digest, files: Array.isArray(result.files) ? result.files.length : result.files, conflicts: result.conflicts?.length ?? 0, unresolved: result.unresolved?.length ?? 0 })}\n`,
  );

  if (
    result.ok === false ||
    result.conflicts?.length ||
    result.unresolved?.length
  )
    process.exitCode = 2;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Omnyo rename refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
