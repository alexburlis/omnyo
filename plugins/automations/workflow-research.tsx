import {
  useEffect,
  useLayoutEffect,
  useState,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
} from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  openSeoRpcContract,
  workflowSourceSelection,
  workflowSourceSnapshot,
} from "./src/openseo-contract";
import type { ResearchDraft } from "./workflow-draft";
import { OPEN_SEO_SETUP_URL } from "./src/openseo-setup-url.js";
import { selectControl } from "./workflow-setup";

type Contract = typeof openSeoRpcContract;

type Target = z.input<Contract["workflow_openseo_status"]["input"]>;

type Status = z.output<Contract["workflow_openseo_status"]["output"]>;

type Projects = Extract<
  z.output<Contract["workflow_openseo_projects"]["output"]>,
  { kind: "ready" }
>["projects"];

type Snapshot = Extract<
  z.output<typeof workflowSourceSnapshot>,
  { kind: "openseo" }
>;

export type ResearchSelection = Extract<
  z.input<typeof workflowSourceSelection>,
  { kind: "openseo" }
>;

const issues = {
  disconnected: "Connect this copy to an OpenSEO project.",
  expired:
    "Update the workspace API key in Automations settings and reconnect.",
  empty: "No saved OpenSEO data matched your request.",
  failed: "OpenSEO could not complete the request. Try again.",
  "budget-blocked": "This OpenSEO request is blocked by the cost limit.",
};

function keywordDetails(keyword: Snapshot["keywords"][number]) {
  return (
    [
      keyword.intent,
      keyword.volume === null
        ? null
        : `Search volume ${new Intl.NumberFormat().format(keyword.volume)}`,
    ]
      .filter((detail) => detail !== null)
      .join(" · ") || "Metrics unavailable"
  );
}

function RetrievalDate({ value }: { value: string }) {
  return (
    <span>
      Retrieved into Omnyo{" "}
      <time dateTime={value}>{value.slice(0, 10)} UTC</time>
    </span>
  );
}

export function ResearchEvidence({ evidence }: { evidence: Snapshot }) {
  return (
    <section aria-label="Saved OpenSEO research" className="space-y-2">
      <h4 className="text-sm font-semibold">Saved OpenSEO research</h4>
      <p className="break-words text-xs text-muted-foreground">
        {evidence.site} · <RetrievalDate value={evidence.retrievedAt} />
      </p>
      <ul className="divide-y rounded-lg border">
        {evidence.keywords.map((keyword) => (
          <li
            key={keyword.id}
            className="min-w-0 break-words px-3 py-2 text-sm"
          >
            <span className="block font-medium">{keyword.keyword}</span>
            <span className="text-xs text-muted-foreground">
              {keywordDetails(keyword)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ResearchPicker({
  target,
  saved,
  draft,
  onDraftChange,
  onReadVerified,
  onOpenSettings,
}: {
  target: Target;
  saved: Snapshot | undefined;
  draft: ResearchDraft;
  onDraftChange: Dispatch<SetStateAction<ResearchDraft>>;
  onReadVerified: (readId: string | undefined) => void;
  onOpenSettings: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const rpc = useRpc<Contract>();
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [projects, setProjects] = useState<Projects>([]);
  const [projectId, setProjectId] = useState("");
  const { site, pending } = draft;
  const read = pending?.kind === "loaded" ? pending : undefined;
  const { projectId: recipientId, importId } = target;

  useLayoutEffect(() => {
    const connection = status?.kind === "connected" ? status.connection : null;

    const matches =
      read &&
      connection &&
      read.connection.site === connection.site &&
      read.connection.openSeoProjectId === connection.openSeoProjectId;

    onReadVerified(!busy && matches ? read.read.readId : undefined);
  }, [busy, onReadVerified, read, status]);

  const returnContext = new URLSearchParams({
    workflowProject: recipientId,
    workflowCopy: importId,
  });

  useEffect(() => {
    let active = true;
    void rpc
      .call("workflow_openseo_status", { projectId: recipientId, importId })
      .then(
        (value) => {
          if (!active) return;
          setStatus(value);

          const connection =
            value.kind === "connected" ? value.connection : null;

          onDraftChange((current) => {
            if (!current.site && connection)
              return { ...current, site: connection.site };

            const pendingRead = current.pending;

            if (
              pendingRead?.kind === "loaded" &&
              (pendingRead.connection.site !== connection?.site ||
                pendingRead.connection.openSeoProjectId !==
                  connection.openSeoProjectId)
            ) {
              return {
                ...current,
                pending: {
                  kind: "reload",
                  connection: pendingRead.connection,
                  keywordIds: pendingRead.keywordIds,
                },
              };
            }

            return current;
          });
          setBusy(false);
        },
        () => {
          if (!active) return;
          setError("Could not check the OpenSEO connection. Try again.");
          setBusy(false);
        },
      );

    return () => {
      active = false;
    };
  }, [rpc, recipientId, importId, onDraftChange]);

  function action(run: () => Promise<void>) {
    setBusy(true);
    setError("");
    void run()
      .catch(() =>
        setError(
          "Could not complete the OpenSEO request. Check the site and try again.",
        ),
      )
      .finally(() => setBusy(false));
  }

  function requestFreshRead() {
    onDraftChange((current) => ({
      ...current,
      keepSaved: false,
      pending:
        current.pending?.kind === "loaded"
          ? {
              kind: "reload",
              connection: current.pending.connection,
              keywordIds: current.pending.keywordIds,
            }
          : current.pending,
    }));
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Use saved keywords to guide topics. Supply product facts in the brief
        below.
      </p>
      {saved && <ResearchEvidence evidence={saved} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p role="status" className="text-sm">
          {busy ? (
            "Checking OpenSEO…"
          ) : status?.kind === "connected" ? (
            <>Connected to {status.connection?.site}</>
          ) : status?.kind === "expired" ? (
            "Connection expired"
          ) : (
            "OpenSEO disconnected"
          )}
        </p>
        {status?.kind === "connected" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              action(async () => {
                requestFreshRead();
                setStatus(
                  await rpc.call("workflow_openseo_disconnect", target),
                );
              })
            }
          >
            Disconnect this copy
          </Button>
        )}
      </div>
      {(!status?.keyConfigured || status.kind === "expired") && !busy && (
        <div className="space-y-2">
          <p className="text-sm">
            Save your workspace API key in Automations settings. Copies on this
            installation can authorize their own OpenSEO projects. After saving,
            select Return to workflow setup.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <a
              className="underline underline-offset-2"
              href={`/settings/plugins/automations?${returnContext}`}
              onClick={onOpenSettings}
            >
              Open Automations settings
            </a>
            <a
              className="underline underline-offset-2"
              href={OPEN_SEO_SETUP_URL}
              target="_blank"
              rel="noreferrer"
            >
              OpenSEO API key guide
            </a>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                action(async () => {
                  setStatus(await rpc.call("workflow_openseo_status", target));
                })
              }
            >
              Check again
            </Button>
          </div>
        </div>
      )}
      {status && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-40 flex-1 space-y-1 text-sm">
              <span>Site domain</span>
              <Input
                value={site}
                placeholder="example.com"
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.value;
                  onDraftChange((current) =>
                    value.trim().toLowerCase() ===
                    current.site.trim().toLowerCase()
                      ? { ...current, site: value }
                      : { site: value, keepSaved: false },
                  );
                  setProjectId("");
                  setProjects([]);
                  setError("");
                }}
              />
            </label>
            {status.keyConfigured && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || !site.trim()}
                onClick={() =>
                  action(async () => {
                    setProjectId("");
                    setProjects([]);
                    requestFreshRead();

                    const result = await rpc.call("workflow_openseo_projects", {
                      ...target,
                      site,
                    });

                    if (result.kind === "ready") setProjects(result.projects);
                    else
                      setError(
                        result.kind === "empty"
                          ? "No OpenSEO projects match this domain."
                          : issues[result.kind],
                      );
                  })
                }
              >
                Find projects
              </Button>
            )}
          </div>
          {projects.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-40 flex-1 space-y-1 text-sm">
                <span>OpenSEO project</span>
                <select
                  className={selectControl}
                  value={projectId}
                  disabled={busy}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">Choose project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !projectId}
                onClick={() =>
                  action(async () => {
                    requestFreshRead();

                    const result = await rpc.call("workflow_openseo_connect", {
                      ...target,
                      site,
                      openSeoProjectId: projectId,
                    });

                    setStatus(
                      await rpc.call("workflow_openseo_status", target),
                    );

                    if (result.kind !== "connected")
                      setError(issues[result.kind]);
                    else setProjects([]);
                  })
                }
              >
                Connect this copy
              </Button>
            </div>
          )}
          {status.kind === "connected" &&
            status.connection &&
            site.trim().toLowerCase() === status.connection.site && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const connection = status.connection;

                  if (!connection) return;
                  action(async () => {
                    requestFreshRead();

                    const result = await rpc.call("workflow_openseo_keywords", {
                      ...target,
                      ...connection,
                    });

                    if (result.kind === "ready") {
                      onDraftChange((current) => {
                        const previous = current.pending;

                        const matches =
                          previous?.connection.site === connection.site &&
                          previous.connection.openSeoProjectId ===
                            connection.openSeoProjectId;

                        const keywordIds = matches
                          ? previous.keywordIds.filter((id) =>
                              result.keywords.some(
                                (keyword) => keyword.id === id,
                              ),
                            )
                          : [];

                        return {
                          ...current,
                          pending: {
                            kind: "loaded",
                            connection,
                            read: result,
                            keywordIds,
                            needsReview: keywordIds.length > 0,
                          },
                        };
                      });
                    } else {
                      if (
                        result.kind === "expired" ||
                        result.kind === "disconnected"
                      )
                        setStatus(
                          await rpc.call("workflow_openseo_status", target),
                        );
                      setError(
                        result.kind === "empty"
                          ? "This site has no saved keywords. Save keywords in OpenSEO or choose Product notes."
                          : issues[result.kind],
                      );
                    }
                  });
                }}
              >
                Load saved keywords
              </Button>
            )}
        </div>
      )}
      {pending?.kind === "reload" && pending.keywordIds.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Load saved keywords again to review your draft selections.
        </p>
      )}
      {saved && !draft.keepSaved && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            onDraftChange({ site: saved.site, keepSaved: true });
            setProjectId("");
            setProjects([]);
            setError("");
          }}
        >
          Keep saved research for {saved.site}
        </Button>
      )}
      {read && (
        <fieldset className="space-y-1" disabled={busy}>
          <legend className="text-sm font-medium">
            Choose keywords for this brief
          </legend>
          <p className="text-xs text-muted-foreground">
            <RetrievalDate value={read.read.retrievedAt} />
          </p>
          <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
            {read.read.keywords.map((keyword) => {
              const selected = read.keywordIds;

              return (
                <li key={keyword.id}>
                  <label className="flex min-w-0 items-start gap-2 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 shrink-0 accent-foreground"
                      checked={selected.includes(keyword.id)}
                      onChange={(event) => {
                        const keywordIds = event.target.checked
                          ? [...selected, keyword.id]
                          : selected.filter((id) => id !== keyword.id);

                        onDraftChange((current) => ({
                          ...current,
                          pending: { ...read, keywordIds },
                        }));
                      }}
                    />
                    <span className="min-w-0 break-words">
                      <span className="block font-medium">
                        {keyword.keyword}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {keywordDetails(keyword)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          {read.needsReview && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={read.keywordIds.length === 0}
              onClick={() =>
                onDraftChange((current) => ({
                  ...current,
                  pending: { ...read, needsReview: false },
                }))
              }
            >
              Use selected keywords
            </Button>
          )}
        </fieldset>
      )}
      {error && (
        <p className="text-sm text-destructive-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
