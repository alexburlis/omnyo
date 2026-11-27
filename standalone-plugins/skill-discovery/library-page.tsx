import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { z } from "zod";
import {
  experimental_useAppNavigate,
  experimental_FileLink as FileLink,
  experimental_usePluginId,
  experimental_useProviders,
  Markdown,
  useRpc,
  useSdk,
} from "@omnyo/plugin-sdk/app";
import type { PluginNavPanelProps } from "@omnyo/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { buildCatalogue, filterCatalogue } from "./catalogue";
import { SkillDraft, type DraftPart, type DraftProvider } from "./library-draft";
import { operationSchema, sourceLocatorSchema, targetSchema } from "./library-contract";
import type {
  Collection,
  Library,
  LibraryLink,
  LibraryOperation,
  SavedPrompt,
  Workspace,
} from "./library-contract";
import type { libraryRpc } from "./library-rpc";
import {
  canEditSource,
  catalogueRows,
  collectionPath,
  libraryRows,
  searchRows,
  sourceLocator,
} from "./library-view";
import type { InstalledSource, LibraryRow } from "./library-view";
import { linkedReview, PackExplorer, PackExportForm, type PackInput } from "./pack-explorer";
import { MarketplacePage } from "./marketplace-page";
import { skillFileSource } from "./markdown-import";
import { maxPackBytes } from "./pack";
import { CuratedBrowser } from "./curated-browser";
import { LoadIssue, SkillInspector } from "./skill-inspector";
import { PromptHistoryBrowser } from "./prompt-browser";
import { useSkillWorkspace, type SkillWorkspaceState } from "./use-skill-workspace";

const sectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home") }),
  z.object({ kind: z.literal("catalogue"), path: z.array(z.string()).max(2) }),
  z.object({ kind: z.literal("collection"), id: z.string() }),
  z.object({ kind: z.literal("prompts") }),
  z.object({ kind: z.literal("history") }),
  z.object({ kind: z.literal("explore") }),
  z.object({ kind: z.literal("marketplace") }),
  z.object({ kind: z.literal("discover") }),
]);

const localSchema = z.object({
  section: sectionSchema,
  expanded: z.array(z.string()),
  rowKey: z.string().nullable(),
  provider: z.string(),
  draft: z.array(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string() }),
      z.object({
        kind: z.literal("skill"),
        source: sourceLocatorSchema,
        mode: z.enum(["mention", "reference", "fork"]),
      }),
    ]),
  ),
});

type Preferences = z.infer<typeof localSchema>;

type Section = z.infer<typeof sectionSchema>;

type Pane = "tree" | "list" | "detail";

type FormState =
  | { kind: "collection"; existing?: Collection; parentId: string | null }
  | { kind: "rename"; link: LibraryLink; title: string }
  | {
      kind: "link";
      row: Extract<LibraryRow, { kind: "skill" | "prompt" }>;
      source?: InstalledSource;
    }
  | { kind: "reference"; collectionId: string }
  | {
      kind: "prompt";
      existing?: SavedPrompt;
      initialTitle?: string;
      initialBody?: string;
      skillId?: string;
    }
  | { kind: "move-link"; link: LibraryLink }
  | { kind: "move-collection"; collection: Collection }
  | { kind: "remove"; operation: LibraryOperation; label: string }
  | { kind: "export"; collection: Collection };

type Toast = { message: string; undo?: LibraryOperation };

const names = new Map([
  ["omnyo-builtin", "Built-in"],
  ["omnyo-project", "Project · Omnyo"],
  ["omnyo-user", "Personal · Omnyo"],
  ["provider-project", "Project · Provider"],
  ["provider-user", "Personal · Provider"],
  ["shared-project", "Project · Shared"],
  ["shared-user", "Personal · Shared"],
  ["plugin", "Managed plugin"],
]);

const emptyLibrary: Library = { revision: 0, collections: [], links: [], prompts: [] };

function scopeLabel(scope: string) {
  return names.get(scope) ?? scope;
}

function initialPreferences(key: string): Preferences {
  try {
    const value = window.localStorage.getItem(key);

    if (value !== null) {
      const result = localSchema.safeParse(JSON.parse(value));

      if (result.success) return result.data;
    }
  } catch {
    console.warn("Could not read saved Skills preferences.");
  }

  return {
    section: { kind: "catalogue", path: [] },
    expanded: [],
    rowKey: null,
    provider: "",
    draft: [],
  };
}

function keyboardRows(event: KeyboardEvent<HTMLDivElement>) {
  if (
    !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) ||
    !(event.target instanceof HTMLButtonElement) ||
    !event.target.hasAttribute("data-sd-row")
  )
    return;
  const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-sd-row]"));
  const current = rows.indexOf(event.target);

  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? rows.length - 1
        : event.key === "ArrowUp"
          ? current - 1
          : current + 1;

  const next = rows[index];

  if (next) {
    event.preventDefault();
    next.focus();
  }
}

function WorkspacePicker({
  state,
  destinationLocked,
  provider,
  scope,
  providerLabel,
  providerFilter,
  scopeFilter,
}: {
  state: SkillWorkspaceState;
  destinationLocked: boolean;
  provider: string;
  scope: string;
  providerLabel(provider: string | null): string;
  providerFilter(value: string): void;
  scopeFilter(value: string): void;
}) {
  const providers = [...new Set(state.sources.map((source) => source.provider ?? "shared"))];
  const scopes = [...new Set(state.sources.map((source) => source.scope))].sort();

  return (
    <details className="sd-filters">
      <summary className="sd-button">
        <Icon name="SlidersHorizontal" aria-hidden="true" /> Workspace
      </summary>
      <div className="sd-filter-fields sd-form">
        <label>
          Project
          <select
            value={state.workspace.projectId ?? ""}
            disabled={destinationLocked}
            onChange={(event) =>
              state.setWorkspace({ projectId: event.target.value || null, environmentId: null })
            }
          >
            <option value="" disabled>
              Choose a project
            </option>
            {state.projectList.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Environment
          <select
            value={state.workspace.environmentId ?? ""}
            disabled={destinationLocked || state.workspace.projectId === null}
            onChange={(event) =>
              state.setWorkspace({ ...state.workspace, environmentId: event.target.value || null })
            }
          >
            <option value="">Source checkout</option>
            {state.workspace.environmentId &&
              !state.environmentList.some(
                (environment) => environment.id === state.workspace.environmentId,
              ) && (
                <option disabled value={state.workspace.environmentId}>
                  Selected environment unavailable
                </option>
              )}
            {state.environmentList.map((environment) => (
              <option
                key={environment.id}
                value={environment.id}
                disabled={environment.status !== "ready"}
              >
                {environment.name ?? environment.branchName ?? environment.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider filter
          <select value={provider} onChange={(event) => providerFilter(event.target.value)}>
            <option value="">All providers</option>
            {providers.map((item) => (
              <option key={item} value={item}>
                {providerLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope filter
          <select value={scope} onChange={(event) => scopeFilter(event.target.value)}>
            <option value="">All scopes</option>
            {scopes.map((item) => (
              <option key={item} value={item}>
                {scopeLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <button className="sd-button" type="button" onClick={state.reload}>
          <Icon name="skill-discovery-refresh" aria-hidden="true" /> Refresh inventory
        </button>
      </div>
    </details>
  );
}

function ReferenceInspector({
  row,
  state,
}: {
  row: Extract<LibraryRow, { kind: "reference" }>;
  state: SkillWorkspaceState;
}) {
  const sdk = useSdk();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  const fileTarget =
    state.rootPath === null || state.hostId === undefined
      ? null
      : {
          kind: "host" as const,
          hostId: state.hostId,
          path: `${state.rootPath.replace(/[\\/]$/u, "")}${state.rootPath.includes("\\") ? "\\" : "/"}${row.filePath}`,
        };

  useEffect(() => {
    const request = new AbortController();
    setContent(null);
    setError("");

    if (state.rootPath === null || state.hostId === undefined) {
      setError("The selected workspace has no available checkout.");

      return () => request.abort();
    }

    void sdk.files
      .read({
        rootPath: state.rootPath,
        path: `${state.rootPath.replace(/[\\/]$/u, "")}${state.rootPath.includes("\\") ? "\\" : "/"}${row.filePath}`,
        hostId: state.hostId,
        signal: request.signal,
      })
      .then((result) => {
        if (result.contentEncoding !== "utf8")
          throw new Error("This file is not a UTF-8 document.");

        if (!request.signal.aborted) setContent(result.content);
      })
      .catch((reason) => {
        if (!request.signal.aborted)
          setError(reason instanceof Error ? reason.message : "The request failed. Try again.");
      });

    return () => request.abort();
  }, [sdk, reload, row.filePath, state.hostId, state.rootPath]);

  return (
    <>
      <dl className="sd-meta">
        <dt>Project</dt>
        <dd>{state.project?.name ?? "Selected project"}</dd>
        <dt>Path</dt>
        <dd>
          <code>{row.filePath}</code>
        </dd>
      </dl>
      {fileTarget && (
        <FileLink target={fileTarget} className="sd-button">
          Open file
        </FileLink>
      )}
      {error ? (
        <LoadIssue
          title="Reference unavailable"
          problem={error}
          retry={() => setReload((value) => value + 1)}
        />
      ) : content === null ? (
        <p className="sd-muted" role="status">
          Loading reference…
        </p>
      ) : /\.md(?:own)?$/iu.test(row.filePath) ? (
        <Markdown content={content} className="sd-markdown" />
      ) : (
        <pre className="sd-file-content">{content}</pre>
      )}
    </>
  );
}

function OperationEditor({
  form,
  collectionMap,
  library,
  busy,
  error,
  onApply,
  onClose,
}: {
  form: Exclude<FormState, { kind: "export" }>;
  collectionMap: Map<string, Collection>;
  library: Library;
  busy: boolean;
  error: string;
  onApply(operation: LibraryOperation): void;
  onClose(): void;
}) {
  const [moveDestination, setMoveDestination] = useState(() =>
    form.kind === "move-link"
      ? form.link.collectionId
      : form.kind === "move-collection"
        ? (form.collection.parentId ?? "")
        : (library.collections[0]?.id ?? ""),
  );

  const id = useId();

  const destinationOptions =
    form.kind === "move-collection"
      ? library.collections.filter(
          (collection) =>
            !collectionPath(collectionMap, collection.id).some(
              (parent) => parent.id === form.collection.id,
            ),
        )
      : library.collections;

  const orderLink =
    form.kind === "move-link"
      ? library.links.filter(
          (link) => link.collectionId === moveDestination && link.id !== form.link.id,
        )
      : [];

  const orderCollection =
    form.kind === "move-collection"
      ? library.collections.filter(
          (collection) =>
            collection.parentId === (moveDestination || null) &&
            collection.id !== form.collection.id,
        )
      : [];

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get("title") ?? "").trim();
    const description = String(data.get("description") ?? "").trim();
    const beforeId = String(data.get("beforeId") ?? "") || undefined;

    switch (form.kind) {
      case "collection":
        onApply(
          form.existing
            ? { kind: "collection.update", id: form.existing.id, title, description }
            : { kind: "collection.create", parentId: form.parentId, title, description },
        );

        return;
      case "rename":
        onApply({ kind: "link.update", id: form.link.id, title });

        return;
      case "prompt": {
        const body = String(data.get("body") ?? "");
        const skillId = form.skillId ?? form.existing?.skillId;
        onApply(
          form.existing
            ? { kind: "prompt.update", id: form.existing.id, title, body, skillId }
            : { kind: "prompt.create", title, body, skillId },
        );

        return;
      }

      case "link": {
        const target =
          form.row.kind === "skill"
            ? { kind: "skill", source: sourceLocator(form.source ?? form.row.source) }
            : { kind: "prompt", promptId: form.row.prompt.id };

        onApply({
          kind: "link.add",
          collectionId: moveDestination,
          target: targetSchema.parse(target),
          title: title || undefined,
          role: data.get("entry") ? "entry" : undefined,
        });

        return;
      }

      case "reference":
        onApply({
          kind: "link.add",
          collectionId: form.collectionId,
          title: title || undefined,
          target: { kind: "reference", path: String(data.get("path") ?? "") },
        });

        return;
      case "move-link":
        onApply({ kind: "link.move", id: form.link.id, collectionId: moveDestination, beforeId });

        return;
      case "move-collection":
        onApply({
          kind: "collection.move",
          id: form.collection.id,
          parentId: moveDestination || null,
          beforeId,
        });

        return;
      case "remove":
        onApply(form.operation);
    }
  }

  const heading =
    form.kind === "collection"
      ? form.existing
        ? "Edit collection"
        : "New collection"
      : form.kind === "rename"
        ? "Rename item"
        : form.kind === "prompt"
          ? form.existing
            ? "Edit saved prompt"
            : "New saved prompt"
          : form.kind === "link"
            ? "Add to collection"
            : form.kind === "reference"
              ? "Link project reference"
              : form.kind.startsWith("move")
                ? "Move"
                : "Remove";

  const saveLabel =
    form.kind === "remove"
      ? "Remove"
      : form.kind.startsWith("move")
        ? "Move"
        : form.kind === "link" || form.kind === "reference"
          ? "Add link"
          : "Save";

  return (
    <form
      className="sd-form sd-editor"
      onSubmit={save}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onClose();
        }
      }}
      aria-labelledby={id}
    >
      <h3 id={id}>{heading}</h3>
      {form.kind === "collection" && (
        <>
          <label>
            Name
            <input
              name="title"
              autoFocus
              required
              maxLength={120}
              defaultValue={form.existing?.title}
            />
          </label>
          <label>
            Summary
            <textarea
              name="description"
              maxLength={2000}
              rows={2}
              defaultValue={form.existing?.description ?? ""}
            />
          </label>
        </>
      )}
      {form.kind === "rename" && (
        <label>
          Display name
          <input name="title" autoFocus required maxLength={120} defaultValue={form.title} />
        </label>
      )}
      {form.kind === "prompt" && (
        <>
          <label>
            Title
            <input
              name="title"
              autoFocus
              required
              maxLength={120}
              defaultValue={form.existing?.title ?? form.initialTitle}
            />
          </label>
          <label>
            Prompt
            <textarea
              name="body"
              rows={9}
              required
              maxLength={65536}
              defaultValue={form.existing?.body ?? form.initialBody}
            />
          </label>
        </>
      )}
      {form.kind === "reference" && (
        <>
          <label>
            Project-relative file path
            <input
              name="path"
              autoFocus
              required
              maxLength={1024}
              placeholder="docs/start-here.md"
            />
          </label>
          <label>
            Display name
            <input name="title" maxLength={120} />
          </label>
        </>
      )}
      {(form.kind === "link" || form.kind === "move-link" || form.kind === "move-collection") && (
        <label>
          Destination
          <select
            value={moveDestination}
            autoFocus
            onChange={(event) => setMoveDestination(event.target.value)}
          >
            {form.kind === "move-collection" && <option value="">Top level</option>}
            {destinationOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {collectionPath(collectionMap, item.id)
                  .map((part) => part.title)
                  .join(" › ")}
              </option>
            ))}
          </select>
        </label>
      )}
      {form.kind === "link" && (
        <>
          <label>
            Display name
            <input name="title" maxLength={120} defaultValue={form.row.title} />
          </label>
          {form.row.kind === "skill" && (
            <label className="sd-check">
              <input type="checkbox" name="entry" /> Mark as Start here
            </label>
          )}
        </>
      )}
      {(orderLink.length > 0 || orderCollection.length > 0) && (
        <label>
          Place before
          <select name="beforeId" key={moveDestination}>
            <option value="">At the end</option>
            {orderLink.map((link) => {
              const { target } = link;

              const label =
                target.kind === "skill"
                  ? target.source.name
                  : target.kind === "reference"
                    ? target.path
                    : (library.prompts.find((prompt) => prompt.id === target.promptId)?.title ??
                      "Saved prompt");

              return (
                <option key={link.id} value={link.id}>
                  {link.title ?? label}
                </option>
              );
            })}
            {orderCollection.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {form.kind === "remove" && <p>{form.label}</p>}
      {error && (
        <p className="sd-notice" role="alert">
          {error}
        </p>
      )}
      <div className="sd-actions">
        <button
          className="sd-button sd-primary"
          disabled={busy || (form.kind === "link" && !moveDestination)}
          type="submit"
        >
          {busy ? "Saving…" : saveLabel}
        </button>
        <button className="sd-button" type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SkillLibraryPage({ subPath }: PluginNavPanelProps) {
  const state = useSkillWorkspace();
  const pluginId = experimental_usePluginId();

  const [fileSource, setFileSource] = useState<PackInput | null>(null);
  const [fileError, setFileError] = useState("");

  return (
    <WorkspaceLibrary
      key={state.key}
      state={state}
      storageKey={`${pluginId}:library:${state.key}`}
      subPath={subPath.replace(/^\//u, "")}
      fileSource={fileSource}
      setFileSource={setFileSource}
      fileError={fileError}
      setFileError={setFileError}
    />
  );
}

function WorkspaceLibrary({
  state,
  storageKey,
  subPath,
  fileSource,
  setFileSource,
  fileError,
  setFileError,
}: {
  state: SkillWorkspaceState;
  storageKey: string;
  subPath: string;
  fileSource: PackInput | null;
  setFileSource(source: PackInput | null): void;
  fileError: string;
  setFileError(error: string): void;
}) {
  const rpc = useRpc<typeof libraryRpc>();
  const navigate = experimental_useAppNavigate();
  const directory = experimental_useProviders();
  const [preferences, setPreferences] = useState(() => initialPreferences(storageKey));
  const [pane, setPane] = useState<Pane>(subPath.startsWith("installed/") ? "detail" : "list");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [scope, setScope] = useState("");
  const [sourceChoice, setSourceChoice] = useState<{ rowKey: string; id: string } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [packBusy, setPackBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [notice, setNotice] = useState<Toast | null>(null);
  const [chooseSource, setChooseSource] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const fileRequest = useRef(0);
  const linkedSource = useMemo(() => linkedReview(subPath), [subPath]);
  const directImport = /^(?:import|source)(?:\/|$)/u.test(subPath);
  const directMarketplace = subPath === "marketplace" || subPath.startsWith("marketplace/");
  const installedId = subPath.startsWith("installed/") ? subPath.slice("installed/".length) : null;

  const marketplaceQuery = directMarketplace
    ? subPath.slice("marketplace/".length).split("/").at(-1)?.slice(0, 80)
    : "";

  const writeRunning = useRef(false);
  const focusRequest = useRef<string | null>(null);
  const { projectId, environmentId } = state.workspace;
  const workspace: Workspace | null = projectId === null ? null : { projectId, environmentId };

  useEffect(() => setComposerOpen(false), [projectId, environmentId]);

  const providerOptions: DraftProvider[] = directory.providers
    .filter((provider) => provider.available)
    .map(({ id, displayName, composerActions }) => ({
      id,
      displayName,
      trigger: composerActions.find((action) => action.kind === "skills")?.trigger ?? null,
    }));

  const contextProvider = providerOptions.find((item) => item.id === preferences.provider);

  const draftProvider =
    contextProvider?.id ??
    providerOptions.find((item) => item.id === "codex")?.id ??
    providerOptions[0]?.id ??
    "";

  const providerLabel = (value: string | null) =>
    value === null || value === "shared"
      ? "Shared"
      : (directory.providers.find((item) => item.id === value)?.displayName ?? value);

  const draftTrigger =
    providerOptions.find((provider) => provider.id === draftProvider)?.trigger ?? null;

  const localLibrary = library ?? emptyLibrary;

  const collectionMap = useMemo(
    () => new Map(localLibrary.collections.map((item) => [item.id, item])),
    [localLibrary.collections],
  );

  let section: Section = preferences.section;

  if (directMarketplace) section = { kind: "marketplace" };
  else if (directImport) section = { kind: "explore" };
  else if (installedId !== null) section = { kind: "catalogue", path: [] };
  else if (section.kind === "collection" && library !== null && !collectionMap.has(section.id))
    section = { kind: "home" };

  const collection = section.kind === "collection" ? collectionMap.get(section.id) : undefined;
  const ancestors = collection ? collectionPath(collectionMap, collection.id) : [];
  const entries = useMemo(() => buildCatalogue(state.sources), [state.sources]);

  const discovered = useMemo(
    () => catalogueRows(filterCatalogue(entries, "", providerFilter, scope)),
    [entries, providerFilter, scope],
  );

  const placed = useMemo(
    () => libraryRows(localLibrary, state.sources),
    [localLibrary, state.sources],
  );

  const inventory = useMemo(
    () => new Map(state.sources.map((item) => [item.id, item])),
    [state.sources],
  );

  const categories = useMemo(() => {
    const paths = new Map<string, Map<string, number>>();

    for (const row of discovered) {
      const label = row.path[0] ?? "Other";
      const groups = paths.get(label) ?? new Map<string, number>();
      const group = row.path[1] ?? "";
      groups.set(group, (groups.get(group) ?? 0) + 1);
      paths.set(label, groups);
    }

    return paths;
  }, [discovered]);

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch {
      console.warn("Could not save Skills preferences.");
    }
  }, [storageKey, preferences]);

  useEffect(() => {
    if (projectId === null) return;
    let abandoned = false;
    setLoadError("");

    void rpc
      .call("libraryGet", { projectId, environmentId })
      .then((value) => {
        if (!abandoned) setLibrary(value);
      })
      .catch((reason) => {
        if (!abandoned)
          setLoadError(reason instanceof Error ? reason.message : "The request failed. Try again.");
      });

    return () => {
      abandoned = true;
    };
  }, [rpc, projectId, environmentId, version]);

  useEffect(() => {
    const selector = focusRequest.current;

    if (selector !== null) {
      focusRequest.current = null;
      const element = root.current?.querySelector<HTMLElement>(selector);
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "nearest" });
    }
  });

  function switchPane(next: Pane, selector: string) {
    if (root.current && root.current.clientWidth < 620) focusRequest.current = selector;
    setPane(next);
  }

  function selectSection(next: Section) {
    if (packBusy) return;

    fileRequest.current += 1;
    setFileSource(null);
    setFileError("");

    if (subPath !== "") navigate.toPluginPanel("browse", { replace: true });
    setQuery("");
    setForm(null);
    setChooseSource(false);
    setSourceChoice(null);
    setPreferences((current) => ({
      ...current,
      section: next,
      rowKey: null,
      expanded:
        next.kind === "collection"
          ? [
              ...new Set([
                ...current.expanded,
                ...collectionPath(collectionMap, next.id).map((item) => item.id),
                next.id,
              ]),
            ]
          : current.expanded,
    }));

    const fullPage =
      next.kind === "explore" || next.kind === "marketplace" || next.kind === "discover";

    switchPane("list", fullPage ? ".sd-full [data-sd-heading]" : ".sd-list [data-sd-heading]");
  }

  async function chooseFiles(files: FileList | null) {
    if (!files?.length || packBusy) return;
    selectSection({ kind: "explore" });
    const attempt = fileRequest.current;

    try {
      if (files.length !== 1) throw new Error("Choose one Markdown file or skill pack at a time.");
      const file = files[0];

      if (file.size > maxPackBytes) throw new Error("Choose a file smaller than 768 KiB.");

      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );

      if (attempt === fileRequest.current) setFileSource(skillFileSource(file.name, text));
    } catch (reason) {
      if (attempt === fileRequest.current)
        setFileError(reason instanceof Error ? reason.message : "The file could not be read.");
    }
  }

  function fold(key: string) {
    setPreferences((current) => ({
      ...current,
      expanded: current.expanded.includes(key)
        ? current.expanded.filter((candidate) => candidate !== key)
        : [...current.expanded, key],
    }));
  }

  function selectRow(row: LibraryRow) {
    if (installedId !== null) navigate.toPluginPanel("browse", { replace: true });
    setForm(null);
    setChooseSource(false);
    setSourceChoice(null);
    setPreferences((current) => ({ ...current, rowKey: row.key }));
    switchPane("detail", ".sd-detail [data-sd-heading]");
  }

  function edit(next: FormState) {
    setFormError("");
    setForm(next);
    switchPane("detail", ".sd-editor input");
  }

  function addDraft(part: DraftPart) {
    if (composerOpen) {
      setNotice({ message: "Use the native composer to add more to this draft." });

      return;
    }

    setPreferences((current) => ({ ...current, draft: [...current.draft, part] }));
    setChooseSource(false);
    setNotice({ message: "Added to chat draft." });
  }

  async function apply(input: LibraryOperation) {
    if (workspace === null || library === null || writeRunning.current) return;
    const parsed = operationSchema.safeParse(input);

    if (!parsed.success) {
      setFormError(parsed.error.issues[0]?.message ?? "Check the form.");

      return;
    }

    writeRunning.current = true;
    setBusy(true);
    setFormError("");

    try {
      const operation = parsed.data;

      const saved = await rpc.call("libraryApply", {
        ...workspace,
        revision: library.revision,
        operation,
      });

      setLibrary(saved);
      setForm(null);

      const previous =
        operation.kind === "link.update" ||
        operation.kind === "link.remove" ||
        operation.kind === "link.move"
          ? library.links.find((link) => link.id === operation.id)
          : undefined;

      const undo: LibraryOperation | undefined = previous
        ? operation.kind === "link.update"
          ? { kind: "link.update", id: previous.id, title: previous.title ?? null }
          : operation.kind === "link.remove"
            ? {
                kind: "link.add",
                collectionId: previous.collectionId,
                title: previous.title,
                target: previous.target,
                role: previous.role,
              }
            : { kind: "link.move", id: previous.id, collectionId: previous.collectionId }
        : undefined;

      setNotice({ message: "Library updated.", undo });

      if (operation.kind === "collection.create") {
        const created = saved.collections.find((item) => !collectionMap.has(item.id));

        if (created) {
          selectSection({ kind: "collection", id: created.id });
          setPreferences((current) => ({
            ...current,
            expanded: [
              ...new Set([
                ...current.expanded,
                ...collectionPath(
                  new Map(saved.collections.map((item) => [item.id, item])),
                  created.id,
                ).map((item) => item.id),
              ]),
            ],
          }));
        }
      } else if (operation.kind === "prompt.create") {
        selectSection({ kind: "prompts" });

        const created = saved.prompts.find(
          (item) => !library.prompts.some((prompt) => prompt.id === item.id),
        );

        if (created) setPreferences((current) => ({ ...current, rowKey: `prompt:${created.id}` }));
      }

      if (operation.kind === "link.update") {
        requestAnimationFrame(() =>
          root.current?.querySelector<HTMLButtonElement>("[data-sd-rename]")?.focus(),
        );
      }
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "The request failed. Try again.");
      setVersion((current) => current + 1);
    } finally {
      writeRunning.current = false;
      setBusy(false);
    }
  }

  const search = query.trim() !== "";

  const rows = search
    ? searchRows([...placed, ...discovered], query)
    : section.kind === "catalogue"
      ? discovered.filter((row) => section.path.every((part, index) => row.path[index] === part))
      : section.kind === "collection"
        ? placed.filter((row) => row.link?.collectionId === section.id)
        : section.kind === "prompts"
          ? placed.filter((row) => row.kind === "prompt" && row.link === null)
          : [];

  const row = rows.find((item) =>
    installedId !== null
      ? item.kind === "skill" && item.variantIds.includes(installedId)
      : item.key === preferences.rowKey,
  );

  const previewSource = linkedSource ?? fileSource;

  const showingInstalled =
    section.kind !== "explore" && section.kind !== "marketplace" && section.kind !== "discover";

  const variantIds = row?.kind === "skill" ? row.variantIds : [];

  const variants = variantIds.flatMap((id) => {
    const source = inventory.get(id);

    return source === undefined ? [] : [source];
  });

  const selectedSource =
    row?.kind === "skill"
      ? inventory.get(
          sourceChoice?.rowKey === row.key ? sourceChoice.id : (installedId ?? row.source.id),
        )
      : undefined;

  const ambiguity =
    selectedSource &&
    ((selectedSource.provider !== null && selectedSource.provider !== draftProvider) ||
      state.sources.some(
        (item) =>
          item.name === selectedSource.name &&
          item.id !== selectedSource.id &&
          (item.provider === null || item.provider === draftProvider),
      ));

  const title = search
    ? "Search results"
    : (collection?.title ??
      (section.kind === "catalogue"
        ? (section.path.at(-1) ?? "All skills")
        : section.kind === "prompts"
          ? "Saved prompts"
          : section.kind === "discover"
            ? "Discover"
            : section.kind === "explore"
              ? "Explore"
              : "Collections"));

  const activeTree =
    section.kind === "collection"
      ? `collection:${section.id}`
      : section.kind === "catalogue"
        ? `catalogue:${JSON.stringify(section.path)}`
        : section.kind;

  const writeReady = library !== null && !busy;
  const expanded = new Set(preferences.expanded);

  function collectionBranch(parentId: string | null, depth: number) {
    if (depth >= 21) return null;

    return localLibrary.collections
      .filter((item) => item.parentId === parentId)
      .map((item) => {
        const key = `collection:${item.id}`;
        const open = expanded.has(item.id);

        const hasChildren = localLibrary.collections.some(
          (candidate) => candidate.parentId === item.id,
        );

        const count = localLibrary.links.filter((link) => link.collectionId === item.id).length;

        return (
          <div className="sd-branch-node" key={item.id}>
            <div className="sd-branch-row" data-selected={activeTree === key}>
              {hasChildren ? (
                <button
                  type="button"
                  className="sd-disclosure"
                  aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`}
                  aria-expanded={open}
                  onClick={() => fold(item.id)}
                >
                  <Icon name="ChevronRight" aria-hidden="true" />
                </button>
              ) : (
                <span className="sd-disclosure-spacer" />
              )}
              <button
                className="sd-tree-item"
                type="button"
                data-sd-row
                data-sd-tree={key}
                aria-current={activeTree === key ? "page" : undefined}
                onClick={() => selectSection({ kind: "collection", id: item.id })}
              >
                <Icon name={hasChildren ? "Folder02" : "Folder"} aria-hidden="true" />
                <span>{item.title}</span>
                {!hasChildren || count > 0 ? <small>{count}</small> : null}
              </button>
            </div>
            {hasChildren && open && (
              <div className="sd-branch">{collectionBranch(item.id, depth + 1)}</div>
            )}
          </div>
        );
      });
  }

  function treeItem(label: string, key: string, icon: string, next: Section, count?: number) {
    return (
      <div className="sd-branch-row" data-selected={activeTree === key}>
        <button
          type="button"
          className="sd-tree-item"
          data-sd-row
          data-sd-tree={key}
          aria-current={activeTree === key ? "page" : undefined}
          onClick={() => selectSection(next)}
        >
          <Icon name={icon} aria-hidden="true" />
          <span>{label}</span>
          {count !== undefined && <small>{count}</small>}
        </button>
      </div>
    );
  }

  function backToTree() {
    setForm(null);
    switchPane("tree", `[data-sd-tree="${CSS.escape(activeTree)}"]`);
  }

  function backToList() {
    setForm(null);
    switchPane(
      "list",
      row ? `[data-sd-item="${CSS.escape(row.key)}"]` : ".sd-list [data-sd-heading]",
    );
  }

  function renderInstalled() {
    return (
      <div className="sd-panes">
        <nav className="sd-pane sd-tree" aria-label="Collections">
          <div onKeyDown={keyboardRows}>
            <div className="sd-section-label">
              <h2>Collections</h2>
              <button
                type="button"
                className="sd-icon-button"
                aria-label="New collection"
                disabled={!writeReady}
                onClick={() => edit({ kind: "collection", parentId: null })}
              >
                <Icon name="Plus" aria-hidden="true" />
              </button>
            </div>
            {collectionBranch(null, 0)}
            {localLibrary.collections.length === 0 && library !== null && (
              <p className="sd-tree-empty">Create a collection to organize skills and prompts.</p>
            )}
            <h2 className="sd-section-label">Library</h2>
            {treeItem(
              "All skills",
              "catalogue:[]",
              "skill-discovery-library",
              { kind: "catalogue", path: [] },
              discovered.length,
            )}
            {treeItem(
              "Saved prompts",
              "prompts",
              "MessageSquare",
              { kind: "prompts" },
              localLibrary.prompts.length,
            )}
            {treeItem("Prompt history", "history", "Clock", { kind: "history" }, 0)}
            <h2 className="sd-section-label">Categories</h2>
            {[...categories].map(([label, children]) => {
              const key = `category:${label}`;

              const open =
                expanded.has(key) ||
                (section.kind === "catalogue" &&
                  section.path.length > 1 &&
                  section.path[0] === label);

              const path = [label];
              const selected = activeTree === `catalogue:${JSON.stringify(path)}`;

              return (
                <div key={label} className="sd-branch-node">
                  <div className="sd-branch-row" data-selected={selected}>
                    <button
                      type="button"
                      className="sd-disclosure"
                      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
                      aria-expanded={open}
                      onClick={() => fold(key)}
                    >
                      <Icon name="ChevronRight" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="sd-tree-item"
                      data-sd-row
                      data-sd-tree={`catalogue:${JSON.stringify(path)}`}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => selectSection({ kind: "catalogue", path })}
                    >
                      <span>{label}</span>
                      <small>{[...children.values()].reduce((sum, count) => sum + count, 0)}</small>
                    </button>
                  </div>
                  {open && (
                    <div className="sd-branch">
                      {[...children].map(([child, count]) => (
                        <div key={child}>
                          {treeItem(
                            child || "General",
                            `catalogue:${JSON.stringify([label, child])}`,
                            "Folder",
                            { kind: "catalogue", path: [label, child] },
                            count,
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </nav>
        {section.kind === "history" && (
          <PromptHistoryBrowser
            query={query}
            projectId={projectId}
            environmentId={environmentId}
            addDraft={(text) => addDraft({ kind: "text", text })}
            onBack={backToTree}
          />
        )}
        <section className="sd-pane sd-list" aria-label="Items" hidden={section.kind === "history"}>
          <button type="button" className="sd-button sd-back" onClick={backToTree}>
            <Icon name="ArrowLeft" aria-hidden="true" /> Collections
          </button>
          {ancestors.length > 1 && (
            <nav className="sd-crumb" aria-label="Collection path">
              {ancestors.slice(0, -1).map((part) => (
                <button
                  type="button"
                  key={part.id}
                  onClick={() => selectSection({ kind: "collection", id: part.id })}
                >
                  {part.title}
                </button>
              ))}
            </nav>
          )}
          <div className="sd-list-head">
            <h2 tabIndex={-1} data-sd-heading>
              {title}
            </h2>
            {section.kind === "prompts" && (
              <button
                type="button"
                className="sd-icon-button"
                aria-label="New saved prompt"
                disabled={!writeReady}
                onClick={() => edit({ kind: "prompt" })}
              >
                <Icon name="Plus" aria-hidden="true" />
              </button>
            )}
          </div>
          {collection?.description && <p className="sd-list-note">{collection.description}</p>}
          {state.loading && (
            <p className="sd-muted" role="status">
              Loading inventory…
            </p>
          )}
          <div className="sd-items" onKeyDown={keyboardRows}>
            {!search &&
              (section.kind === "home" || collection) &&
              localLibrary.collections
                .filter((item) => item.parentId === (collection?.id ?? null))
                .map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="sd-item"
                    data-sd-row
                    onClick={() => selectSection({ kind: "collection", id: item.id })}
                  >
                    <Icon name="Folder" aria-hidden="true" />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                  </button>
                ))}
            {rows.map((item) => (
              <button
                type="button"
                key={item.key}
                className="sd-item"
                data-entry={item.link?.role === "entry"}
                aria-current={row?.key === item.key ? "true" : undefined}
                data-sd-row
                data-sd-item={item.key}
                onClick={() => selectRow(item)}
              >
                <Icon
                  name={
                    item.kind === "prompt"
                      ? "MessageSquare"
                      : item.kind === "reference"
                        ? "FileText"
                        : item.kind === "unavailable"
                          ? "Unavailable"
                          : "Toolbox"
                  }
                  aria-hidden="true"
                />
                <span>
                  {item.link?.role === "entry" && (
                    <small className="sd-entry-label">Start here</small>
                  )}
                  <strong>{item.title}</strong>
                  <small>{search ? item.path.join(" › ") : item.subtitle}</small>
                </span>
              </button>
            ))}
          </div>
          {!state.loading && rows.length === 0 && search && (
            <p className="sd-list-note">No matching skills, prompts or references.</p>
          )}
          {!state.loading && rows.length === 0 && section.kind === "catalogue" && (
            <p className="sd-list-note">No skills match the selected workspace and filters.</p>
          )}
          {!search && section.kind === "home" && localLibrary.collections.length === 0 && (
            <div className="sd-actions sd-landing-actions">
              <button
                type="button"
                className="sd-button sd-primary"
                disabled={!writeReady}
                onClick={() => edit({ kind: "collection", parentId: null })}
              >
                New collection
              </button>
              <button
                type="button"
                className="sd-button"
                onClick={() => selectSection({ kind: "catalogue", path: [] })}
              >
                Browse skills
              </button>
            </div>
          )}
        </section>
        <section
          className="sd-pane sd-detail"
          aria-label="Details"
          hidden={section.kind === "history"}
        >
          <button
            type="button"
            className="sd-button sd-back"
            disabled={packBusy}
            onClick={backToList}
          >
            <Icon name="ArrowLeft" aria-hidden="true" /> {title}
          </button>
          {installedId !== null && row === undefined && !state.loading ? (
            <p role="status" className="sd-muted">
              This skill is unavailable in the selected workspace.
            </p>
          ) : form?.kind === "export" && workspace ? (
            <PackExportForm
              key={form.collection.id}
              workspace={workspace}
              collection={form.collection}
              onClose={() => setForm(null)}
            />
          ) : form !== null && form.kind !== "export" ? (
            <OperationEditor
              form={form}
              collectionMap={collectionMap}
              library={localLibrary}
              busy={busy}
              error={formError}
              onApply={(operation) => void apply(operation)}
              onClose={() => {
                setForm(null);
                requestAnimationFrame(() =>
                  root.current?.querySelector<HTMLButtonElement>("[data-sd-rename]")?.focus(),
                );
              }}
            />
          ) : row ? (
            <>
              {row.path.length > 0 && (
                <nav className="sd-crumb" aria-label="Location">
                  {row.link
                    ? collectionPath(collectionMap, row.link.collectionId).map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          onClick={() => selectSection({ kind: "collection", id: item.id })}
                        >
                          {item.title}
                        </button>
                      ))
                    : row.path.map((part, index) => <span key={`${index}:${part}`}>{part}</span>)}
                </nav>
              )}
              <p className="sd-kind">
                {row.link?.role === "entry"
                  ? "Start here · Skill"
                  : row.kind === "prompt"
                    ? "Saved prompt"
                    : row.kind === "reference"
                      ? "Project reference"
                      : "Skill"}
              </p>
              <div className="sd-title-line">
                <h2 tabIndex={-1} data-sd-heading className="sd-title">
                  {row.title}
                </h2>
                {row.link && (
                  <button
                    type="button"
                    className="sd-icon-button"
                    aria-label={`Rename ${row.title}`}
                    data-sd-rename
                    disabled={!writeReady}
                    onClick={() => {
                      if (row.link) edit({ kind: "rename", link: row.link, title: row.title });
                    }}
                  >
                    <Icon name="Edit" aria-hidden="true" />
                  </button>
                )}
              </div>
              {row.link?.title && (
                <p className="sd-muted sd-reset">
                  Display name
                  <button
                    type="button"
                    className="sd-link-button"
                    disabled={!writeReady}
                    onClick={() => {
                      if (row.link)
                        void apply({ kind: "link.update", id: row.link.id, title: null });
                    }}
                  >
                    Reset
                  </button>
                </p>
              )}
              {selectedSource && row.kind === "skill" && workspace && (
                <>
                  <p className="sd-summary">{selectedSource.description ?? row.subtitle}</p>
                  <div className="sd-actions">
                    <button
                      type="button"
                      className="sd-button sd-primary"
                      onClick={() => {
                        if (ambiguity) setChooseSource(true);
                        else
                          addDraft({
                            kind: "skill",
                            source: sourceLocator(selectedSource),
                            mode: "mention",
                          });
                      }}
                    >
                      Use in chat
                    </button>
                    {!canEditSource(selectedSource) && (
                      <button
                        type="button"
                        className="sd-button"
                        onClick={() =>
                          addDraft({
                            kind: "skill",
                            source: sourceLocator(selectedSource),
                            mode: "fork",
                          })
                        }
                      >
                        Fork in chat
                      </button>
                    )}
                  </div>
                  {chooseSource && (
                    <div className="sd-notice" role="status">
                      <p>
                        Use the exact selected file when this name could resolve to another source.
                      </p>
                      <button
                        type="button"
                        className="sd-button"
                        onClick={() =>
                          addDraft({
                            kind: "skill",
                            source: sourceLocator(selectedSource),
                            mode: "reference",
                          })
                        }
                      >
                        Add file reference
                      </button>
                    </div>
                  )}
                  <dl className="sd-meta">
                    <dt>Invocation</dt>
                    <dd>
                      <code>
                        {draftTrigger}
                        {selectedSource.name}
                      </code>
                    </dd>
                  </dl>
                  <SkillInspector
                    key={selectedSource.id}
                    source={selectedSource}
                    variants={variants}
                    workspace={workspace}
                    hostId={state.hostId}
                    localServer={state.project?.kind === "personal" && environmentId === null}
                    providerLabel={providerLabel}
                    scopeLabel={scopeLabel}
                    onSource={(id) => {
                      setChooseSource(false);
                      setSourceChoice({ rowKey: row.key, id });
                    }}
                    onRemoved={() => {
                      if (installedId !== null) navigate.toPluginPanel("browse", { replace: true });
                      setPreferences((current) => ({ ...current, rowKey: null }));
                      switchPane("list", ".sd-list [data-sd-heading]");
                      state.reload();
                      setNotice({ message: "Skill deleted." });
                    }}
                    onSavePrompt={(content) =>
                      edit({
                        kind: "prompt",
                        initialTitle: row.title,
                        initialBody: content,
                        skillId: selectedSource.name,
                      })
                    }
                  />
                </>
              )}
              {row.kind === "prompt" && (
                <>
                  <div className="sd-actions">
                    <button
                      type="button"
                      className="sd-button sd-primary"
                      onClick={() => addDraft({ kind: "text", text: row.prompt.body })}
                    >
                      Use in chat
                    </button>
                    <button
                      type="button"
                      className="sd-button"
                      disabled={!writeReady}
                      onClick={() => edit({ kind: "prompt", existing: row.prompt })}
                    >
                      Edit prompt
                    </button>
                  </div>
                  <pre className="sd-file-content sd-prompt-content">{row.prompt.body}</pre>
                </>
              )}
              {row.kind === "reference" && (
                <ReferenceInspector key={row.key} row={row} state={state} />
              )}
              {row.kind === "unavailable" && <p className="sd-notice">{row.subtitle}</p>}
              {row.link?.role === "entry" && (
                <div className="sd-related">
                  <h3>In this collection</h3>
                  {placed
                    .filter(
                      (item) =>
                        item.key !== row.key && item.link?.collectionId === row.link?.collectionId,
                    )
                    .map((item) => (
                      <button
                        type="button"
                        key={item.key}
                        className="sd-link-button"
                        onClick={() => selectRow(item)}
                      >
                        {item.title}
                      </button>
                    ))}
                  {localLibrary.collections
                    .filter((item) => item.parentId === row.link?.collectionId)
                    .map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        className="sd-link-button"
                        onClick={() => selectSection({ kind: "collection", id: item.id })}
                      >
                        {item.title}
                      </button>
                    ))}
                </div>
              )}
              <div className="sd-detail-actions sd-actions">
                {(row.kind === "skill" || row.kind === "prompt") &&
                  localLibrary.collections.length > 0 && (
                    <button
                      type="button"
                      className="sd-button"
                      disabled={!writeReady}
                      onClick={() => edit({ kind: "link", row, source: selectedSource })}
                    >
                      Add to collection
                    </button>
                  )}
                {row.link && (
                  <>
                    <button
                      type="button"
                      className="sd-button"
                      disabled={!writeReady}
                      onClick={() => {
                        if (row.link) edit({ kind: "move-link", link: row.link });
                      }}
                    >
                      Move to
                    </button>
                    <button
                      type="button"
                      className="sd-button sd-quiet"
                      disabled={!writeReady}
                      onClick={() => {
                        if (row.link)
                          edit({
                            kind: "remove",
                            operation: { kind: "link.remove", id: row.link.id },
                            label: `Remove the link to “${row.title}” from this collection?`,
                          });
                      }}
                    >
                      Remove link
                    </button>
                  </>
                )}
                {row.kind === "prompt" && row.link === null && (
                  <button
                    type="button"
                    className="sd-button sd-quiet"
                    disabled={!writeReady}
                    onClick={() =>
                      edit({
                        kind: "remove",
                        operation: { kind: "prompt.remove", id: row.prompt.id },
                        label: `Delete “${row.prompt.title}” and its collection links?`,
                      })
                    }
                  >
                    Delete prompt
                  </button>
                )}
              </div>
            </>
          ) : collection ? (
            <>
              <h2 className="sd-title" tabIndex={-1} data-sd-heading>
                {collection.title}
              </h2>
              {collection.description && <p className="sd-summary">{collection.description}</p>}
              <div className="sd-actions">
                <button
                  type="button"
                  className="sd-button sd-primary"
                  disabled={!writeReady}
                  onClick={() => edit({ kind: "collection", parentId: collection.id })}
                >
                  New subcollection
                </button>
                <button
                  type="button"
                  className="sd-button"
                  disabled={!writeReady}
                  onClick={() => edit({ kind: "reference", collectionId: collection.id })}
                >
                  Link reference
                </button>
                <button
                  type="button"
                  className="sd-button"
                  disabled={!writeReady}
                  onClick={() => edit({ kind: "export", collection })}
                >
                  Export pack
                </button>
                <button
                  type="button"
                  className="sd-button sd-quiet"
                  disabled={!writeReady}
                  onClick={() =>
                    edit({
                      kind: "collection",
                      existing: collection,
                      parentId: collection.parentId,
                    })
                  }
                >
                  Edit collection
                </button>
                <button
                  type="button"
                  className="sd-button sd-quiet"
                  disabled={!writeReady}
                  onClick={() => edit({ kind: "move-collection", collection })}
                >
                  Move to
                </button>
                <button
                  type="button"
                  className="sd-button sd-quiet"
                  disabled={!writeReady}
                  onClick={() =>
                    edit({
                      kind: "remove",
                      operation: { kind: "collection.remove", id: collection.id },
                      label: `Remove “${collection.title}” and its collection links? Skill files and saved prompts stay in the library.`,
                    })
                  }
                >
                  Remove collection
                </button>
              </div>
              <p className="sd-muted">Open a skill or saved prompt to add it to this collection.</p>
            </>
          ) : (
            <div className="sd-placeholder">
              <Icon name="Toolbox" aria-hidden="true" />
              <h2 data-sd-heading tabIndex={-1}>
                {search ? "Choose a result" : "Organize skills and prompts"}
              </h2>
              <p>Open a collection or browse the skill inventory.</p>
            </div>
          )}
          {formError && form === null && (
            <p role="alert" className="sd-notice">
              {formError}
            </p>
          )}
        </section>
        {notice && (
          <div className="sd-toast" role="status">
            {notice.message}
            {notice.undo && (
              <button
                type="button"
                className="sd-link-button"
                disabled={busy}
                onClick={() => {
                  if (notice.undo) void apply(notice.undo);
                }}
              >
                Undo
              </button>
            )}
            <button
              type="button"
              className="sd-icon-button"
              aria-label="Dismiss notice"
              onClick={() => setNotice(null)}
            >
              <Icon name="X" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="sd-page text-foreground bg-background"
      ref={root}
      data-pane={pane}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = packBusy ? "none" : "copy";

        if (!packBusy) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void chooseFiles(event.dataTransfer.files);
      }}
      onKeyDown={(event) => {
        if (
          showingInstalled &&
          event.key === "/" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.target instanceof Element &&
          !event.target.closest("input,select,textarea,[contenteditable=true]")
        ) {
          event.preventDefault();
          searchInput.current?.focus();
        }
      }}
    >
      <header className="sd-bar">
        <span className="sd-brand">
          <Icon name="skill-discovery-library" aria-hidden="true" /> Skills
        </span>
        <nav className="sd-tabs sd-top-tabs" aria-label="Skills">
          <button
            type="button"
            aria-current={showingInstalled ? "page" : undefined}
            disabled={packBusy}
            onClick={() => selectSection({ kind: "catalogue", path: [] })}
          >
            Installed
          </button>
          <button
            type="button"
            aria-current={
              section.kind === "marketplace" || section.kind === "discover" ? "page" : undefined
            }
            disabled={packBusy}
            onClick={() => selectSection({ kind: "marketplace" })}
          >
            Marketplace
          </button>
        </nav>
        {showingInstalled && (
          <div className="sd-search">
            <Icon name="Search" aria-hidden="true" />
            <input
              ref={searchInput}
              aria-label={
                section.kind === "history"
                  ? "Search prompt history"
                  : "Search installed skills and prompts"
              }
              type="search"
              placeholder={
                section.kind === "history"
                  ? "Search saved and previous prompts"
                  : "Search installed skills and prompts"
              }
              value={query}
              onChange={(event) => {
                if (installedId !== null) navigate.toPluginPanel("browse", { replace: true });
                setForm(null);
                setQuery(event.target.value);
                setPane("list");
              }}
            />
            <kbd aria-hidden="true">/</kbd>
          </div>
        )}
        <WorkspacePicker
          state={state}
          destinationLocked={packBusy}
          provider={providerFilter}
          scope={scope}
          providerLabel={providerLabel}
          providerFilter={setProviderFilter}
          scopeFilter={setScope}
        />
        <button
          type="button"
          className="sd-button"
          disabled={packBusy}
          onClick={() => selectSection({ kind: "explore" })}
        >
          <Icon name="Plus" aria-hidden="true" /> Import
        </button>
        <input
          ref={fileInput}
          hidden
          type="file"
          aria-label="Import Markdown or skill pack"
          accept=".md,.omnyoskillpack"
          onChange={(event) => {
            const files = event.currentTarget.files;
            void chooseFiles(files);
            event.currentTarget.value = "";
          }}
        />
      </header>
      {dragging && (
        <div className="sd-drop-overlay" aria-hidden="true">
          Drop Markdown or a skill pack
        </div>
      )}
      {state.error && (
        <LoadIssue title="Workspace could not load" problem={state.error} retry={state.reload} />
      )}
      {loadError && (
        <LoadIssue
          title="Collections could not load"
          problem={loadError}
          retry={() => setVersion((value) => value + 1)}
        />
      )}
      {section.kind === "marketplace" ? (
        <MarketplacePage
          initialQuery={marketplaceQuery}
          openCurated={() => selectSection({ kind: "discover" })}
          review={(slug, digest) => {
            selectSection({ kind: "explore" });
            setFileSource({ kind: "marketplace", slug, digest });
          }}
        />
      ) : section.kind === "discover" ? (
        <section className="sd-full sd-import" aria-label="Curated skills">
          <h2 data-sd-heading tabIndex={-1}>
            Curated skills
          </h2>
          <CuratedBrowser
            workspace={state.rootPath ? workspace : null}
            onBusy={setPackBusy}
            onInstalled={() => {
              state.reload();
              setVersion((value) => value + 1);
            }}
          />
        </section>
      ) : section.kind === "explore" ? (
        <section className="sd-full sd-import" aria-label="Import skills">
          {fileError && (
            <p className="sd-notice" role="alert">
              {fileError}
            </p>
          )}
          <PackExplorer
            key={subPath}
            source={previewSource}
            invalidLink={directImport && linkedSource === null}
            state={state}
            onCancel={() =>
              selectSection(
                previewSource?.kind === "marketplace"
                  ? { kind: "marketplace" }
                  : { kind: "catalogue", path: [] },
              )
            }
            onChooseFile={() => fileInput.current?.click()}
            onInstallBusy={setPackBusy}
            onOpenCollection={(receipt) => {
              selectSection({ kind: "collection", id: receipt.collectionId });
              setVersion((value) => value + 1);
              state.reload();
            }}
          />
        </section>
      ) : (
        renderInstalled()
      )}
      <SkillDraft
        key={JSON.stringify([projectId, environmentId])}
        state={state}
        providerId={draftProvider}
        providerOptions={providerOptions}
        parts={preferences.draft}
        onProvider={(provider) => setPreferences((current) => ({ ...current, provider }))}
        onUndo={() =>
          setPreferences((current) => ({ ...current, draft: current.draft.slice(0, -1) }))
        }
        onClear={() => setPreferences((current) => ({ ...current, draft: [] }))}
        onSent={() => setPreferences((current) => ({ ...current, draft: [] }))}
        onOpenChange={setComposerOpen}
      />
    </div>
  );
}
