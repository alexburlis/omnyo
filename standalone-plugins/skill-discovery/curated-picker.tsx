import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useComposer,
  useRpc,
  useSdk,
  experimental_useProviders,
  experimental_usePluginId,
  type ComposerDraftSnapshot,
} from "@omnyo/plugin-sdk/app";
import { curatedMentionProviderId, curatedRpc, type CuratedEntry } from "./curated-contract";
import { CuratedBrowser, type InstalledChoice } from "./curated-browser";
import { nativeSkillMention, replaceSkillMention, sameSkillPath } from "./curated-draft";
import type { Workspace } from "./library-contract";
import type { InstalledSource } from "./library-view";

export const curatedPopupId = "find-skills";

type Context = { workspace: Workspace; providerId: string; canInstall: boolean };

export function CuratedPicker({ initialSkillQuery = "" }: { initialSkillQuery?: string } = {}) {
  const composer = useComposer();
  const sdk = useSdk();
  const rpc = useRpc<typeof curatedRpc>();
  const providers = experimental_useProviders();
  const pluginId = experimental_usePluginId();
  const [context, setContext] = useState<Context | null>(null);
  const [sources, setSources] = useState<InstalledSource[]>([]);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const selectionKey = JSON.stringify([composer.key, composer.scope, composer.selection]);
  const currentKey = useRef(selectionKey);
  currentKey.current = selectionKey;

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    setContext(null);
    setSources([]);

    async function load() {
      let next: Context | null = null;

      if (composer.scope.kind === "new-thread") {
        const projectId = composer.selection?.projectId ?? composer.scope.projectId;
        const providerId = composer.selection?.providerId;
        const environment = composer.selection?.environment;

        if (projectId && providerId) {
          let canInstall = false;

          if (environment?.type === "reuse") {
            const selected = await sdk.environments.get({
              environmentId: environment.environmentId,
              signal: abort.signal,
            });

            canInstall = selected.projectId === projectId && Boolean(selected.path);
          } else if (environment?.type !== "provider") {
            const project = await sdk.projects.get({ projectId, signal: abort.signal });
            const source = project.sources.find((candidate) => candidate.isDefault);
            canInstall =
              !!source &&
              (environment?.type !== "host" ||
                ((!environment.hostId || source.hostId === environment.hostId) &&
                  environment.workspace.type === "unmanaged" &&
                  (environment.workspace.path === null ||
                    sameSkillPath(environment.workspace.path, source.path))));
          }

          next = {
            workspace: {
              projectId,
              environmentId: environment?.type === "reuse" ? environment.environmentId : null,
            },
            providerId,
            canInstall,
          };
        }
      } else {
        const thread = await sdk.threads.get({
          threadId: composer.scope.threadId,
          signal: abort.signal,
        });

        const canInstall = thread.environmentId
          ? Boolean(
              (
                await sdk.environments.get({
                  environmentId: thread.environmentId,
                  signal: abort.signal,
                })
              ).path,
            )
          : (
              await sdk.projects.get({ projectId: thread.projectId, signal: abort.signal })
            ).sources.some((source) => source.isDefault);

        next = {
          workspace: { projectId: thread.projectId, environmentId: thread.environmentId },
          providerId: composer.selection?.providerId ?? thread.providerId,
          canInstall,
        };
      }

      if (abort.signal.aborted) return;
      setContext(next);

      if (next) {
        const inventory = await sdk.skills.list({ ...next.workspace, signal: abort.signal });

        if (!abort.signal.aborted)
          setSources(
            next.canInstall
              ? inventory.skills
              : inventory.skills.filter(
                  (source) =>
                    source.scope.endsWith("user") ||
                    source.scope === "omnyo-builtin" ||
                    source.scope === "plugin",
                ),
          );
      }
    }

    void load().catch((cause) => {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Installed skills could not load.");
    });

    return () => abort.abort();
  }, [sdk, composer, selectionKey]);

  const trigger =
    providers.providers
      .find((provider) => provider.id === context?.providerId)
      ?.composerActions.find((action) => action.kind === "skills")?.trigger ?? null;

  const installed: InstalledChoice[] = useMemo(() => {
    const compatible = sources.filter(
      (source) => source.provider === null || source.provider === context?.providerId,
    );

    return compatible.map((source) => ({
      source,
      disabledReason:
        trigger === null
          ? "This provider does not support skill pills."
          : compatible.some((other) => other.id !== source.id && other.name === source.name)
            ? "Choose this exact source in Skill Library."
            : null,
    }));
  }, [sources, context, trigger]);

  function finish(message: string) {
    toast.success(message);
    composer.experimental_closePopup();
    composer.focus();
  }

  function insertInstalled(source: InstalledSource, useOnceReference?: string | null) {
    if (trigger === null)
      throw new Error(
        "This provider does not support skill pills. Open Skill Library to use the exact source.",
      );

    if (
      sources.some(
        (other) =>
          other.name === source.name &&
          other.id !== source.id &&
          (other.provider === null || other.provider === context?.providerId),
      )
    )
      throw new Error(
        "More than one installed source has this name. Choose the exact source in Skill Library.",
      );

    const duplicate = composer.draft.mentions.some(
      (mention) =>
        mention.kind === "command" && mention.source === "skill" && mention.name === source.name,
    );

    if (duplicate) {
      finish(`${source.name} is already in the draft.`);

      return;
    }

    const replacing =
      useOnceReference &&
      composer.draft.mentions.find(
        (mention) =>
          mention.kind === "plugin" &&
          mention.pluginId === pluginId &&
          mention.provider === curatedMentionProviderId &&
          mention.id === useOnceReference,
      );

    if (replacing) {
      composer.replace((draft) =>
        replaceSkillMention(draft, replacing, nativeSkillMention(source, trigger)),
      );
    } else composer.insert(nativeSkillMention(source, trigger));
    finish(`Added ${source.name}.`);
  }

  function unchanged(draft: ComposerDraftSnapshot, key: string) {
    return (
      mounted.current &&
      currentKey.current === key &&
      composer.draft === draft &&
      !composer.isSubmitting
    );
  }

  async function chooseCurated(entry: CuratedEntry, generation: string) {
    const label = `Use once: ${entry.name}`;

    const draft = composer.draft;
    const key = currentKey.current;
    const { reference } = await rpc.call("catalogPrepare", { id: entry.id, generation });

    if (!unchanged(draft, key))
      throw new Error("The draft changed. Choose the skill again to add it.");

    if (
      composer.draft.mentions.some(
        (mention) =>
          mention.kind === "plugin" &&
          mention.pluginId === pluginId &&
          mention.provider === curatedMentionProviderId &&
          mention.id === reference,
      )
    ) {
      finish(`${entry.name} is already in the draft.`);

      return;
    }

    composer.insert({ provider: curatedMentionProviderId, id: reference, label });
    finish(`Added ${entry.name} for one-time use.`);
  }

  const reviewDraft = useRef({ draft: composer.draft, key: selectionKey });

  return (
    <div className="sd-page sd-picker">
      {error && (
        <p role="alert" className="sd-notice">
          {error}
        </p>
      )}
      <CuratedBrowser
        initialQuery={initialSkillQuery}
        workspace={context?.canInstall ? context.workspace : null}
        installed={installed}
        chooseInstalled={(source) => {
          try {
            insertInstalled(source);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The skill could not be inserted.");
          }
        }}
        chooseCurated={chooseCurated}
        onReviewStart={() => {
          reviewDraft.current = { draft: composer.draft, key: currentKey.current };
        }}
        onInstalled={async (receipt, _entry, review) => {
          const expected = reviewDraft.current;

          if (!unchanged(expected.draft, expected.key)) return;

          const inventory = await sdk.skills.list({
            projectId: receipt.projectId,
            environmentId: receipt.environmentId,
          });

          if (!unchanged(expected.draft, expected.key)) return;
          setSources(inventory.skills);
          const skill = receipt.pack.skills[0];
          const expectedPath = `${review.workspacePath}/.omnyo/skills/${skill?.id}/SKILL.md`;

          const source = inventory.skills.find((item) =>
            sameSkillPath(item.filePath, expectedPath),
          );

          if (!source)
            throw new Error(
              "The skill was installed. Refresh Skill Library to choose its exact source.",
            );

          if (
            inventory.skills.filter(
              (item) =>
                item.name === source.name &&
                (item.provider === null || item.provider === context?.providerId),
            ).length !== 1
          )
            throw new Error("The skill was installed. Choose its exact source in Skill Library.");
          insertInstalled(source, review.useOnceReference);
        }}
        close={() => composer.experimental_closePopup()}
      />
    </div>
  );
}
