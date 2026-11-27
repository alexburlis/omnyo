import { useEffect, useState } from "react";
import { Markdown, useRpc } from "@omnyo/plugin-sdk/app";
import { Icon } from "./components/ui/icon";
import type { PromptRow, promptLibraryRpcContract } from "./prompt-contract";

export function PromptHistoryBrowser({
  query,
  projectId,
  environmentId,
  addDraft,
  onBack,
}: {
  query: string;
  projectId: string | null;
  environmentId: string | null;
  addDraft(text: string): void;
  onBack(): void;
}) {
  const rpc = useRpc<typeof promptLibraryRpcContract>();
  const [allProjects, setAllProjects] = useState(false);
  const [rows, setRows] = useState<PromptRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");

    const deadline = window.setTimeout(() => {
      if (!active) return;
      active = false;
      setLoading(false);
      setError("Loading prompts timed out. Try again.");
    }, 5_000);

    const timer = window.setTimeout(() => {
      void rpc
        .call("search", {
          query,
          scope: allProjects || projectId === null ? "global" : "project",
          projectId,
          threadId: null,
          environmentId,
          composer: "follow-up",
        })
        .then((result) => {
          if (active) setRows(result.prompts);
        })
        .catch((reason) => {
          if (active)
            setError(reason instanceof Error ? reason.message : "Could not load prompts.");
        })
        .finally(() => {
          if (active) {
            window.clearTimeout(deadline);
            setLoading(false);
          }
        });
    }, 60);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(deadline);
    };
  }, [rpc, query, allProjects, projectId, environmentId, revision]);

  const row = rows.find((item) => `${item.kind}:${item.id}` === selected) ?? rows[0];
  const starred = row?.kind === "starred" || row?.starredId != null;

  async function toggleStar() {
    if (!row) return;
    setError("");

    try {
      const id = row.kind === "starred" ? row.id : row.starredId;

      if (id) await rpc.call("unstar", { id });
      else
        await rpc.call("star", {
          prompt: { text: row.prompt.text, mentions: row.prompt.mentions },
        });
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the prompt.");
    }
  }

  async function usePrompt() {
    if (!row) return;

    try {
      if (row.kind === "starred") await rpc.call("markUsed", { id: row.id });
      addDraft(row.prompt.text);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not use the prompt.");
    }
  }

  return (
    <section className="sd-pane sd-list sd-prompt-history" aria-label="Prompt history">
      <button type="button" className="sd-button sd-back" onClick={onBack}>
        <Icon name="ArrowLeft" aria-hidden="true" /> Collections
      </button>
      <div className="sd-list-head">
        <h2 data-sd-heading tabIndex={-1}>
          Prompt history
        </h2>
        <label className="sd-muted">
          <input
            type="checkbox"
            checked={allProjects}
            onChange={(event) => setAllProjects(event.target.checked)}
          />
          All projects
        </label>
      </div>
      {error && (
        <p className="sd-notice" role="alert">
          {error}{" "}
          <button
            className="sd-link-button"
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {loading && (
        <p className="sd-muted" role="status">
          Searching prompts…
        </p>
      )}
      <div className="sd-prompt-columns">
        <div className="sd-items" aria-label="Prompts">
          {rows.map((item) => (
            <button
              className="sd-item"
              type="button"
              key={`${item.kind}:${item.id}`}
              aria-current={item === row ? "true" : undefined}
              onClick={() => setSelected(`${item.kind}:${item.id}`)}
            >
              <Icon
                name={
                  item.kind === "starred"
                    ? "Star"
                    : item.kind === "saved"
                      ? "MessageSquare"
                      : "Clock"
                }
                aria-hidden="true"
              />
              <span>
                <strong>{item.kind === "saved" ? item.title : item.snippet.text}</strong>
                <small>
                  {item.kind === "starred"
                    ? "Starred"
                    : item.kind === "saved"
                      ? "Saved prompt"
                      : (item.projectName ?? "Previous prompt")}
                </small>
              </span>
            </button>
          ))}
          {!loading && !error && rows.length === 0 && (
            <p className="sd-muted">No matching prompts.</p>
          )}
        </div>
        {row && (
          <div className="sd-prompt-preview">
            <div className="sd-actions">
              <button
                className="sd-button sd-primary"
                type="button"
                onClick={() => void usePrompt()}
              >
                Use in chat
              </button>
              <button
                className="sd-button"
                type="button"
                aria-pressed={starred}
                onClick={() => void toggleStar()}
              >
                <Icon name="Star" aria-hidden="true" />
                {starred ? "Starred" : "Star"}
              </button>
            </div>
            <Markdown content={row.prompt.text} className="sd-markdown" />
          </div>
        )}
      </div>
    </section>
  );
}
