import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  inspectDeclarations,
  inspectSource,
  selectSource,
  siblingPolicyPath,
} from "./invocation.ts";

const skill = "---\nname: specialist\ndescription: Specialist instructions.\n---\n# Body\n";

const policyPath = "/skills/specialist/agents/openai.yaml";

const absent = { status: "absent", path: policyPath };

const source = {
  id: "exact-source",
  name: "specialist",
  description: "Specialist instructions.",
  filePath: "/skills/specialist/SKILL.md",
  provider: "codex",
  scope: "provider-user",
  pluginId: null,
};

const workspace = {
  projectId: "project",
  environmentId: "environment",
  hostId: "selected-host",
  localServer: false,
};

const hash = (content) => createHash("sha256").update(content).digest("hex");

const file = (path, content, contentEncoding = "utf8") => ({
  path,
  content,
  contentEncoding,
  sha256: hash(content),
  sizeBytes: Buffer.byteLength(content),
});

const present = (content) => ({
  status: "present",
  content,
  path: policyPath,
  sha256: hash(content),
});

test("Codex literal false is distinct from Claude menu visibility", () => {
  const result = inspectDeclarations(
    skill.replace("name: specialist", "name: specialist\nuser-invocable: false"),
    present("policy:\n  allow_implicit_invocation: false\n"),
  );

  assert.deepEqual(result.codex.allowImplicitInvocation, { value: false, origin: "declared" });
  assert.deepEqual(result.claude.userInvocable, { value: false, origin: "declared" });
  assert.deepEqual(result.claude.disableModelInvocation, { value: false, origin: "default" });
  assert.equal(result.effectiveEnablement, "unknown");
  assert.equal(result.modelInclusion, "unknown");
  assert.equal(result.canonicalIdentity, "unknown");
  assert.equal("content" in result.codex.policy, false);
});

test("Claude manual-only declaration leaves its menu flag at the native default", () => {
  const result = inspectDeclarations(
    skill.replace("name: specialist", "name: specialist\ndisable-model-invocation: true"),
    absent,
  );

  assert.deepEqual(result.claude.disableModelInvocation, { value: true, origin: "declared" });
  assert.deepEqual(result.claude.userInvocable, { value: true, origin: "default" });
});

test("Codex true and absent declaration retain distinct origins", () => {
  assert.deepEqual(
    inspectDeclarations(skill, present("policy:\n  allow_implicit_invocation: true")).codex
      .allowImplicitInvocation,
    { value: true, origin: "declared" },
  );
  assert.deepEqual(
    inspectDeclarations(skill, present("interface:\n  display_name: Specialist")).codex
      .allowImplicitInvocation,
    { value: true, origin: "default" },
  );
  assert.deepEqual(inspectDeclarations(skill, absent).codex.allowImplicitInvocation, {
    value: true,
    origin: "default",
  });
});

test("unavailable policy remains unknown instead of using a missing-file default", () => {
  const result = inspectDeclarations(skill, {
    status: "unavailable",
    path: policyPath,
    reason: "Truncated file list",
  });

  assert.deepEqual(result.codex.allowImplicitInvocation, { value: null, origin: "unknown" });
});

test("malformed YAML and non-boolean declarations fail visibly", () => {
  assert.throws(() => inspectDeclarations("---\nname: [broken\n---\n", absent), /malformed YAML/);
  assert.throws(() => inspectDeclarations("---\nname: specialist\n", absent), /not closed/);
  assert.throws(() => inspectDeclarations(skill, present("policy: [broken")), /malformed YAML/);
  assert.throws(
    () => inspectDeclarations(skill, present('policy:\n  allow_implicit_invocation: "false"')),
    /YAML boolean/,
  );
  assert.throws(
    () =>
      inspectDeclarations(
        skill.replace("name: specialist", 'name: specialist\nuser-invocable: "false"'),
        absent,
      ),
    /YAML booleans/,
  );
  assert.throws(
    () =>
      inspectDeclarations(
        skill,
        present("policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true"),
      ),
    /malformed YAML/,
  );
});

test("frontmatter supports CRLF and does not parse body examples as declarations", () => {
  const result = inspectDeclarations(
    skill.replaceAll("\n", "\r\n") + "disable-model-invocation: true\n",
    absent,
  );

  assert.deepEqual(result.claude.disableModelInvocation, { value: false, origin: "default" });
});

test("opaque IDs select the requested variant instead of a same-name alternative", () => {
  const other = { ...source, id: "other", provider: "claude-code", filePath: "/other/SKILL.md" };
  assert.equal(selectSource([other, source], source.id), source);
  assert.throws(() => selectSource([other, source], source.name), /not discovered/);
  assert.equal(
    siblingPolicyPath("C:\\skills\\specialist\\SKILL.md"),
    "C:\\skills\\specialist\\agents\\openai.yaml",
  );
});

test("regular sources read only the exact file and sibling policy on the selected host", async () => {
  const calls = [];

  const sdk = {
    files: {
      async read(args) {
        calls.push(args);

        return file(
          args.path,
          args.path === source.filePath ? skill : "policy:\n  allow_implicit_invocation: false",
        );
      },
    },
  };

  const result = await inspectSource(sdk, source, workspace);
  assert.deepEqual(
    calls.map(({ hostId, path }) => ({ hostId, path })),
    [
      { hostId: "selected-host", path: source.filePath },
      { hostId: "selected-host", path: policyPath },
    ],
  );
  assert.equal(result.source.id, source.id);
  assert.equal(result.source.contentSha256, hash(skill));
  assert.equal(result.declarations.codex.allowImplicitInvocation.value, false);
});

test("an absent optional host policy is defaulted only for a typed ENOENT", async () => {
  const sdk = {
    files: {
      async read(args) {
        if (args.path === source.filePath) return file(args.path, skill);
        throw Object.assign(new Error("missing"), { status: 404, code: "ENOENT" });
      },
    },
  };

  const result = await inspectSource(sdk, source, workspace);
  assert.equal(result.declarations.codex.policy.status, "absent");
  assert.equal(result.declarations.codex.allowImplicitInvocation.origin, "default");
});

test("permission failures and unavailable hosts never substitute a default or local file", async () => {
  const failure = Object.assign(new Error("permission denied"), { status: 403, code: "EACCES" });

  const sdk = {
    files: {
      async read(args) {
        if (args.path === source.filePath) return file(args.path, skill);
        throw failure;
      },
    },
  };

  await assert.rejects(inspectSource(sdk, source, workspace), (error) => error === failure);
  await assert.rejects(
    inspectSource(sdk, source, { ...workspace, hostId: undefined }),
    /no available source host/,
  );
});

test("binary skill and policy reads are rejected", async () => {
  const binarySkill = {
    files: {
      async read(args) {
        return file(args.path, "AA==", "base64");
      },
    },
  };

  await assert.rejects(inspectSource(binarySkill, source, workspace), /UTF-8 Markdown/);

  const binaryPolicy = {
    files: {
      async read(args) {
        return file(
          args.path,
          args.path === source.filePath ? skill : "AA==",
          args.path === source.filePath ? "utf8" : "base64",
        );
      },
    },
  };

  await assert.rejects(inspectSource(binaryPolicy, source, workspace), /UTF-8 YAML/);
});

test("cancellation is forwarded and stops before the next read", async () => {
  const controller = new AbortController();
  let reads = 0;

  const sdk = {
    files: {
      async read(args) {
        reads++;
        assert.equal(args.signal, controller.signal);
        controller.abort();

        return file(args.path, skill);
      },
    },
  };

  await assert.rejects(inspectSource(sdk, source, workspace, controller.signal), {
    name: "AbortError",
  });
  assert.equal(reads, 1);
});

test("plugin sources use the exact skill ID and relative package API", async () => {
  const calls = [];
  const pluginSource = { ...source, pluginId: "plugin", scope: "plugin" };

  const sdk = {
    skills: {
      async getContent(args) {
        calls.push(args);

        return {
          content: args.path === "SKILL.md" ? skill : "policy:\n  allow_implicit_invocation: false",
          revision: "revision",
        };
      },
      async listFiles(args) {
        calls.push(args);

        return { files: ["SKILL.md", "agents/openai.yaml"], truncated: false };
      },
    },
  };

  const result = await inspectSource(sdk, pluginSource, workspace);
  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      (call) => call.skillId === source.id && call.environmentId === workspace.environmentId,
    ),
  );
  assert.equal(calls[2].path, "agents/openai.yaml");
  assert.equal(result.declarations.codex.allowImplicitInvocation.value, false);
  assert.equal(
    result.declarations.codex.policy.sha256,
    hash("policy:\n  allow_implicit_invocation: false"),
  );
  assert.notEqual(result.declarations.codex.policy.sha256, "revision");
});

test("truncated plugin listings do not establish optional-file absence", async () => {
  const sdk = {
    skills: {
      async getContent() {
        return { content: skill, revision: "revision" };
      },
      async listFiles() {
        return { files: ["SKILL.md"], truncated: true };
      },
    },
  };

  const result = await inspectSource(sdk, { ...source, pluginId: "plugin" }, workspace);
  assert.equal(result.declarations.codex.policy.status, "unavailable");
  assert.equal(result.declarations.codex.allowImplicitInvocation.origin, "unknown");
});

test("native nullable Codex policy fields retain the documented default", () => {
  assert.deepEqual(
    inspectDeclarations(skill, present("policy: null")).codex.allowImplicitInvocation,
    { value: true, origin: "default" },
  );
  assert.deepEqual(
    inspectDeclarations(skill, present("policy:\n  allow_implicit_invocation: null")).codex
      .allowImplicitInvocation,
    { value: true, origin: "default" },
  );
});

test("Omnyo user sources use the exact-owner skills API without assuming the workspace host", async () => {
  const calls = [];

  const sdk = {
    skills: {
      async getContent(args) {
        calls.push(args);

        return { content: skill, revision: "opaque-revision" };
      },
      async listFiles() {
        return { files: ["SKILL.md"], truncated: false };
      },
    },
  };

  const result = await inspectSource(
    sdk,
    { ...source, provider: null, scope: "omnyo-user" },
    { ...workspace, hostId: undefined },
  );

  assert.equal(calls[0].skillId, source.id);
  assert.equal(result.declarations.codex.policy.status, "unavailable");
  assert.equal(result.declarations.codex.allowImplicitInvocation.value, null);
});
