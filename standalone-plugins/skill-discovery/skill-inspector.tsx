import { useEffect, useId, useState } from "react";
import { Markdown, useSdk } from "@omnyo/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { canEditSource, type InstalledSource, type SkillWorkspace } from "./library-view";

type Content = { content: string; revision: string };

type PackageFiles = { files: string[]; truncated: boolean };

type Read<T> = { key: string; value: T } | { key: string; error: string };

const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/;

export function LoadIssue({
  title,
  problem,
  retry,
}: {
  title: string;
  problem: string;
  retry(): void;
}) {
  return (
    <div className="sd-notice" role="alert">
      <strong>{title}</strong>
      <p>{problem}</p>
      <button className="sd-button" onClick={retry} type="button">
        Try again
      </button>
    </div>
  );
}

export function SkillInspector({
  source,
  variants,
  workspace,
  hostId,
  localServer,
  providerLabel,
  scopeLabel,
  onSource,
  onSavePrompt,
  onRemoved,
}: {
  source: InstalledSource;
  variants: InstalledSource[];
  workspace: SkillWorkspace;
  hostId: string | undefined;
  localServer: boolean;
  providerLabel(provider: string | null): string;
  scopeLabel(scope: string): string;
  onSource(sourceId: string): void;
  onSavePrompt(content: string): void;
  onRemoved(): void;
}) {
  const sdk = useSdk();
  const sourceGroup = useId();
  const [tab, setTab] = useState<"overview" | "files">("overview");
  const [file, setFile] = useState("SKILL.md");
  const [overview, setOverview] = useState<Read<Content> | null>(null);
  const [fileContent, setFileContent] = useState<Read<Content> | null>(null);
  const [files, setFiles] = useState<Read<PackageFiles> | null>(null);
  const [reload, setReload] = useState(0);

  const [editing, setEditing] = useState<{
    prefix: string;
    value: string;
    revision: string;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [status, setStatus] = useState("");
  const { projectId, environmentId } = workspace;
  const sourceKey = JSON.stringify([projectId, environmentId, source.id, reload]);
  const fileKey = JSON.stringify([sourceKey, file]);

  useEffect(() => {
    const request = new AbortController();

    const read = async () => {
      if (source.scope === "shared-project" || source.scope === "shared-user") {
        if (hostId === undefined && !localServer)
          throw new Error("The selected workspace has no available source host.");

        const result = await sdk.files.read({
          hostId,
          path: source.filePath,
          signal: request.signal,
        });

        if (result.contentEncoding !== "utf8")
          throw new Error("The selected skill is not a UTF-8 Markdown file.");

        return { content: result.content, revision: result.sha256 };
      }

      return sdk.skills.getContent({
        projectId,
        environmentId,
        skillId: source.id,
        path: "SKILL.md",
        signal: request.signal,
      });
    };

    void read()
      .then((value) => {
        if (!request.signal.aborted) setOverview({ key: sourceKey, value });
      })
      .catch((reason) => {
        if (!request.signal.aborted)
          setOverview({
            key: sourceKey,
            error: reason instanceof Error ? reason.message : "Try again.",
          });
      });

    return () => request.abort();
  }, [
    sdk,
    environmentId,
    hostId,
    localServer,
    projectId,
    source.filePath,
    source.id,
    source.scope,
    sourceKey,
  ]);

  useEffect(() => {
    if (tab !== "files") return;
    const request = new AbortController();

    void sdk.skills
      .listFiles({
        projectId,
        environmentId,
        skillId: source.id,
        signal: request.signal,
      })
      .then((value) => {
        if (!request.signal.aborted) setFiles({ key: sourceKey, value });
      })
      .catch((reason) => {
        if (!request.signal.aborted)
          setFiles({
            key: sourceKey,
            error: reason instanceof Error ? reason.message : "Try again.",
          });
      });

    return () => request.abort();
  }, [sdk, environmentId, projectId, source.id, sourceKey, tab]);

  useEffect(() => {
    if (tab !== "files" || file === "SKILL.md") return;
    const request = new AbortController();

    void sdk.skills
      .getContent({
        projectId,
        environmentId,
        skillId: source.id,
        path: file,
        signal: request.signal,
      })
      .then((value) => {
        if (!request.signal.aborted) setFileContent({ key: fileKey, value });
      })
      .catch((reason) => {
        if (!request.signal.aborted)
          setFileContent({
            key: fileKey,
            error: reason instanceof Error ? reason.message : "Try again.",
          });
      });

    return () => request.abort();
  }, [sdk, environmentId, file, fileKey, projectId, source.id, tab]);

  function retry() {
    setReload((current) => current + 1);
  }

  async function saveInstructions() {
    if (editing === null || saving || editing.value.trim() === "") return;
    setSaving(true);
    setSaveError("");

    try {
      const content = editing.prefix + editing.value;

      const result = await sdk.skills.update({
        projectId,
        environmentId,
        skillId: source.id,
        revision: editing.revision,
        content,
      });

      setOverview({ key: sourceKey, value: { content, revision: result.revision } });
      setEditing(null);
      setStatus("Instructions saved.");
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function removeSkill() {
    if (deleting) return;
    setDeleting(true);
    setDeleteError("");

    try {
      await sdk.skills.remove({ projectId, environmentId, skillId: source.id });
      onRemoved();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "The skill could not be deleted.");
    } finally {
      setDeleting(false);
    }
  }

  const selectedContent =
    tab === "overview" || file === "SKILL.md"
      ? overview?.key === sourceKey
        ? overview
        : null
      : fileContent?.key === fileKey
        ? fileContent
        : null;

  const packageFiles = files?.key === sourceKey ? files : null;

  return (
    <>
      <fieldset className="sd-source-set">
        <legend>Source</legend>
        {variants.map((candidate) => (
          <label key={candidate.id} className="sd-source-card">
            <input
              type="radio"
              name={sourceGroup}
              checked={candidate.id === source.id}
              disabled={editing !== null || deleting || confirmDelete}
              onChange={() => onSource(candidate.id)}
            />
            <span>
              <strong>{scopeLabel(candidate.scope)}</strong>
              <small>{candidate.pluginId ?? providerLabel(candidate.provider)}</small>
              <code>{candidate.filePath}</code>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="sd-tabs" aria-label="Skill views">
        <button type="button" aria-pressed={tab === "overview"} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button
          type="button"
          aria-pressed={tab === "files"}
          disabled={editing !== null}
          onClick={() => setTab("files")}
        >
          Files
        </button>
      </div>
      {tab === "files" &&
        (packageFiles === null ? (
          <p role="status" className="sd-muted">
            Loading files…
          </p>
        ) : "error" in packageFiles ? (
          <LoadIssue title="Files could not load" problem={packageFiles.error} retry={retry} />
        ) : (
          <div className="sd-file-picker">
            <label>
              Package file
              <select value={file} onChange={(event) => setFile(event.target.value)}>
                {packageFiles.value.files.map((path) => (
                  <option key={path}>{path}</option>
                ))}
              </select>
            </label>
            {packageFiles.value.truncated ? (
              <p className="sd-muted">Only the first files are shown.</p>
            ) : null}
          </div>
        ))}
      {editing !== null ? (
        <form
          className="sd-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveInstructions();
          }}
        >
          <label>
            Instructions
            <textarea
              autoFocus
              rows={14}
              maxLength={1_000_000 - editing.prefix.length}
              disabled={saving}
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
            />
          </label>
          {saveError && (
            <div role="alert" className="sd-notice">
              <strong>Instructions were not saved</strong>
              <p>{saveError}</p>
              <p>Copy your edit before reopening the latest instructions.</p>
            </div>
          )}
          <div className="sd-actions">
            <button
              className="sd-button sd-primary"
              disabled={saving || editing.value.trim() === ""}
              type="submit"
            >
              {saving ? "Saving…" : "Save instructions"}
            </button>
            <button
              className="sd-button"
              disabled={saving}
              type="button"
              onClick={() => {
                setEditing(null);
                setSaveError("");

                if (saveError) retry();
              }}
            >
              {saveError ? "Discard and reload" : "Cancel"}
            </button>
          </div>
        </form>
      ) : selectedContent === null ? (
        <p className="sd-muted" role="status">
          Loading instructions…
        </p>
      ) : "error" in selectedContent ? (
        <LoadIssue
          title="This source could not be read"
          problem={selectedContent.error}
          retry={retry}
        />
      ) : tab === "files" ? (
        <pre className="sd-file-content">{selectedContent.value.content}</pre>
      ) : (
        <>
          {status && (
            <p role="status" className="sd-muted">
              {status}
            </p>
          )}
          {canEditSource(source) && (
            <button
              className="sd-button"
              type="button"
              onClick={() => {
                const content = selectedContent.value.content;
                const prefix = frontmatter.exec(content)?.[0] ?? "";
                setStatus("");
                setEditing({
                  prefix,
                  value: content.slice(prefix.length),
                  revision: selectedContent.value.revision,
                });
              }}
            >
              <Icon name="Edit" aria-hidden="true" />
              Edit instructions
            </button>
          )}
          <button
            className="sd-button sd-quiet"
            type="button"
            onClick={() => onSavePrompt(selectedContent.value.content.replace(frontmatter, ""))}
          >
            Save as prompt
          </button>
          <button
            className="sd-button sd-quiet"
            type="button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([selectedContent.value.content], { type: "text/markdown;charset=utf-8" }),
              );

              const link = document.createElement("a");
              link.href = url;
              link.download = `${source.name.replace(/[^a-z0-9_-]+/giu, "-") || "skill"}.md`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Icon name="Download" aria-hidden="true" /> Export Markdown
          </button>
          {canEditSource(source) &&
            (confirmDelete ? (
              <div className="sd-notice">
                <p>Delete this skill and its package files from this workspace?</p>
                {deleteError && <p role="alert">{deleteError}</p>}
                <div className="sd-actions">
                  <button
                    className="sd-button sd-danger"
                    type="button"
                    disabled={deleting}
                    onClick={() => void removeSkill()}
                  >
                    {deleting ? "Deleting…" : "Delete skill"}
                  </button>
                  <button
                    className="sd-button"
                    type="button"
                    disabled={deleting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="sd-button sd-quiet"
                type="button"
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </button>
            ))}
          <Markdown
            content={selectedContent.value.content.replace(frontmatter, "")}
            className="sd-markdown"
          />
        </>
      )}
    </>
  );
}
