import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { parseDocument } from "yaml";
import type { SkillSource } from "./catalogue";
import { z } from "zod";

const frontmatterSchema = z.object({
  "disable-model-invocation": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
});

const policySchema = z.object({
  policy: z.object({ allow_implicit_invocation: z.boolean().nullish() }).nullish(),
});

interface BooleanDeclaration {
  value: boolean | null;
  origin: "declared" | "default" | "unknown";
}

export type PolicyContent =
  | { status: "present"; content: string; path: string; sha256: string }
  | { status: "absent"; path: string }
  | { status: "unavailable"; path: string; reason: string };

function parseYaml(content: string, label: string) {
  const document = parseDocument(content, { version: "1.2", uniqueKeys: true });

  if (document.errors.length > 0) throw new Error(`${label} contains malformed YAML.`);

  return document;
}

export function inspectDeclarations(content: string, policy: PolicyContent) {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);

  if (!match && /^\uFEFF?---[ \t]*(?:\r?\n|$)/u.test(content))
    throw new Error("SKILL.md frontmatter is not closed.");

  const frontmatter = match
    ? frontmatterSchema.safeParse(
        parseYaml(match[1], "SKILL.md frontmatter").toJS({ maxAliasCount: 20 }),
      )
    : frontmatterSchema.safeParse({});

  if (!frontmatter.success)
    throw new Error("SKILL.md invocation declarations must be YAML booleans.");

  const disable = frontmatter.data["disable-model-invocation"];
  const userInvocable = frontmatter.data["user-invocable"];
  let allowImplicitInvocation: BooleanDeclaration;

  if (policy.status === "unavailable") {
    allowImplicitInvocation = { value: null, origin: "unknown" };
  } else if (policy.status === "absent") {
    allowImplicitInvocation = { value: true, origin: "default" };
  } else {
    const parsed = policySchema.safeParse(
      parseYaml(policy.content, "agents/openai.yaml").toJS({ maxAliasCount: 20 }),
    );

    if (!parsed.success)
      throw new Error(
        "agents/openai.yaml policy.allow_implicit_invocation must be a YAML boolean.",
      );

    const declared = parsed.data.policy?.allow_implicit_invocation ?? undefined;
    allowImplicitInvocation = {
      value: declared ?? true,
      origin: declared === undefined ? "default" : "declared",
    };
  }

  const policyFile =
    policy.status === "present"
      ? { status: policy.status, path: policy.path, sha256: policy.sha256 }
      : policy;

  return {
    claude: {
      frontmatter: match ? "present" : "absent",
      disableModelInvocation: {
        value: disable ?? false,
        origin: disable === undefined ? "default" : "declared",
      },
      userInvocable: {
        value: userInvocable ?? true,
        origin: userInvocable === undefined ? "default" : "declared",
      },
    },
    codex: { policy: policyFile, allowImplicitInvocation },
    effectiveEnablement: "unknown",
    modelInclusion: "unknown",
    canonicalIdentity: "unknown",
  };
}

type InspectionSdk = Pick<PluginApi["sdk"], "files" | "skills">;

export interface InspectionWorkspace {
  projectId: string;
  environmentId: string | null;
  hostId: string | undefined;
  localServer: boolean;
}

const missingFile = z.object({ status: z.literal(404), code: z.literal("ENOENT") });

export function selectSource(sources: readonly SkillSource[], sourceId: string): SkillSource {
  const source = sources.find((item) => item.id === sourceId);

  if (!source) throw new Error("The source ID was not discovered in the selected workspace.");

  return source;
}

export function usesSkillApi(source: SkillSource): boolean {
  return (
    source.pluginId !== null || source.scope === "omnyo-builtin" || source.scope === "omnyo-user"
  );
}

export function siblingPolicyPath(filePath: string): string {
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(filePath) ? win32 : posix;

  return paths.join(paths.dirname(filePath), "agents", "openai.yaml");
}

export async function inspectSource(
  sdk: InspectionSdk,
  source: SkillSource,
  workspace: InspectionWorkspace,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const policyPath = siblingPolicyPath(source.filePath);
  let content: string;
  let revision: string;
  let policy: PolicyContent;

  if (usesSkillApi(source)) {
    const identity = {
      projectId: workspace.projectId,
      environmentId: workspace.environmentId,
      skillId: source.id,
      signal,
    };

    const markdown = await sdk.skills.getContent({ ...identity, path: "SKILL.md" });
    signal?.throwIfAborted();
    content = markdown.content;
    revision = markdown.revision;
    const files = await sdk.skills.listFiles(identity);

    if (files.files.includes("agents/openai.yaml")) {
      const result = await sdk.skills.getContent({ ...identity, path: "agents/openai.yaml" });
      policy = {
        status: "present",
        content: result.content,
        path: policyPath,
        sha256: createHash("sha256").update(result.content, "utf8").digest("hex"),
      };
    } else if (files.truncated) {
      policy = {
        status: "unavailable",
        path: policyPath,
        reason: "The package file list is truncated.",
      };
    } else {
      policy = {
        status: "unavailable",
        path: policyPath,
        reason:
          "The package API did not return this optional policy; absence and unreadability are not distinguished.",
      };
    }
  } else {
    if (workspace.hostId === undefined && !workspace.localServer)
      throw new Error("The selected workspace has no available source host.");

    const markdown = await sdk.files.read({
      hostId: workspace.hostId,
      path: source.filePath,
      signal,
    });

    if (markdown.contentEncoding !== "utf8")
      throw new Error("The selected SKILL.md is not a UTF-8 Markdown file.");

    signal?.throwIfAborted();
    content = markdown.content;
    revision = markdown.sha256;

    try {
      const result = await sdk.files.read({ hostId: workspace.hostId, path: policyPath, signal });

      if (result.contentEncoding !== "utf8")
        throw new Error("The selected agents/openai.yaml is not a UTF-8 YAML file.");

      policy = {
        status: "present",
        content: result.content,
        path: policyPath,
        sha256: result.sha256,
      };
    } catch (cause) {
      signal?.throwIfAborted();

      if (!missingFile.safeParse(cause).success) throw cause;

      policy = { status: "absent", path: policyPath };
    }
  }

  signal?.throwIfAborted();

  return {
    source: {
      id: source.id,
      name: source.name,
      provider: source.provider,
      scope: source.scope,
      pluginId: source.pluginId,
      filePath: source.filePath,
      contentSha256: createHash("sha256").update(content, "utf8").digest("hex"),
      revision,
    },
    declarations: inspectDeclarations(content, policy),
  };
}
