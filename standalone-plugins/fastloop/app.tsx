import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useComposers,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginThreadPanelProps,
} from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import { uiContract } from "./contracts.js";
import { jobViewSchema, RunDetailsView, type EvidenceView, type JobView } from "./details.js";
import { loadPreview, previewChunkSchema, type Preview } from "./preview.js";
import "./app.css";

const runIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

const eventViewSchema = z.object({
  nextSequence: z.number().int().nonnegative(),
  resyncRequired: z.boolean(),
  job: z.object({ state: jobViewSchema.shape.state }),
});

const active = (job: JobView) => job.state === "accepted" || job.state === "running";

function RunViewer({ threadId, runId }: { threadId: string; runId: string }) {
  const rpc = useRpc<typeof uiContract>();
  const composers = useComposers();
  const [job, setJob] = useState<JobView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [deliveryRevision, setDeliveryRevision] = useState(0);
  const [delivery, setDelivery] = useState<string>();
  const [deliveryError, setDeliveryError] = useState(false);
  const connection = useRealtimeConnectionState();
  const [preview, setPreview] = useState<{ title: string; content: Preview }>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewRequest = useRef<AbortController | undefined>(undefined);

  const composer = composers.find(
    (item) => item.scope.kind === "thread" && item.scope.threadId === threadId,
  );

  useRealtime("fastloop.delivery", (payload) => {
    const hint = z.object({ runId: runIdSchema }).safeParse(payload);

    if (hint.success && hint.data.runId === runId) setDeliveryRevision((value) => value + 1);
  });

  useEffect(() => {
    let closed = false;
    void rpc
      .call("getDelivery", { threadId, runId })
      .then((value) => {
        if (!closed) {
          setDelivery(value.state);
          setDeliveryError(false);
        }
      })
      .catch(() => {
        if (!closed) setDeliveryError(true);
      });

    return () => {
      closed = true;
    };
  }, [rpc, threadId, runId, deliveryRevision, connection]);

  useEffect(() => {
    let closed = false;
    setJob(undefined);
    setError(undefined);

    async function observe() {
      let current = jobViewSchema.parse(await rpc.call("getRun", { threadId, runId }));

      if (current.runId !== runId) throw new Error("RUN_ID_MISMATCH");

      if (closed) return;
      setJob(current);
      let after = current.lastEventSequence;

      while (!closed && active(current)) {
        const batch = eventViewSchema.parse(
          await rpc.call("events", { threadId, runId, after, waitMs: 10000 }),
        );

        if (closed) return;

        if (batch.resyncRequired || !["accepted", "running"].includes(batch.job.state)) {
          current = jobViewSchema.parse(await rpc.call("getRun", { threadId, runId }));

          if (current.runId !== runId) throw new Error("RUN_ID_MISMATCH");

          if (closed) return;
          setJob(current);
          after = current.lastEventSequence;
        } else after = batch.nextSequence;
      }
    }

    void observe().catch(() => {
      if (!closed) setError("Unable to load the current result. Retry to reconnect.");
    });

    return () => {
      closed = true;
    };
  }, [rpc, threadId, runId, retry]);

  useEffect(
    () => () => {
      previewRequest.current?.abort();
    },
    [],
  );

  async function cancel() {
    setBusy(true);

    try {
      await rpc.call("cancelRun", { threadId, runId });
    } catch {
      setError("Cancellation could not be confirmed. Reconnect to check the run.");
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(evidence: EvidenceView) {
    if (evidence.runId !== runId) {
      setError("This evidence belongs to another run.");

      return;
    }

    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewLoading(true);
    setError(undefined);

    try {
      const content = await loadPreview(
        evidence,
        async (offset) =>
          previewChunkSchema.parse(
            await rpc.call("readArtifact", {
              threadId,
              runId,
              evidenceId: evidence.id,
              offset,
              maxBytes: 262144,
            }),
          ),
        controller.signal,
      );

      if (!controller.signal.aborted) setPreview({ title: evidence.relativePath, content });
    } catch {
      if (!controller.signal.aborted)
        setError("Evidence could not be verified for preview. The run result remains available.");
    } finally {
      if (!controller.signal.aborted) setPreviewLoading(false);
    }
  }

  function prepareRecheck() {
    if (!composer || !job?.result) return;
    composer.insert(
      `Recheck FastLoop run ${runId} after my code changes. Reuse session ${job.result.sessionId} and the original requirements and checks. Provide an explicit ChangeContext for the actual changed files and build. If that session is unavailable, report the refusal before creating a new session.`,
      { at: "end", block: true },
    );
  }

  return (
    <div className="fastloop-panel">
      {job?.result && delivery === "uncertain" ? (
        <p role="status">
          The completion notice is unconfirmed. This result remains available; no duplicate notice
          will be sent automatically.
        </p>
      ) : null}
      {job?.result && (delivery === "queued" || delivery === "sending") ? (
        <p role="status">The completion notice is pending in this chat.</p>
      ) : null}
      {job?.result && delivery === "suppressed" ? (
        <p role="status">The completion notice was stopped because this chat changed.</p>
      ) : null}
      {job?.result && deliveryError ? (
        <div role="status">
          <p>The completion notice status could not load.</p>
          <button type="button" onClick={() => setDeliveryRevision((value) => value + 1)}>
            Retry notice status
          </button>
        </div>
      ) : null}
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry connection
          </button>
        </div>
      ) : null}
      {job ? (
        <RunDetailsView
          job={job}
          busy={busy}
          onCancel={() => {
            void cancel();
          }}
          onEvidence={(evidence) => {
            void openEvidence(evidence);
          }}
        />
      ) : !error ? (
        <p role="status">Loading run…</p>
      ) : null}
      {job?.result && !active(job) && composer ? (
        <button type="button" onClick={prepareRecheck}>
          Prepare recheck in chat
        </button>
      ) : null}
      {previewLoading ? <p role="status">Loading evidence…</p> : null}
      {preview ? (
        <EvidencePreview
          key={preview.title}
          title={preview.title}
          content={preview.content}
          onClose={() => {
            previewRequest.current?.abort();
            setPreview(undefined);
            setPreviewLoading(false);
          }}
        />
      ) : null}
    </div>
  );
}

function EvidencePreview({
  title,
  content,
  onClose,
}: {
  title: string;
  content: Preview;
  onClose(): void;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (content.mimeType === "text/plain") {
      setUrl(undefined);

      return;
    }

    const next = URL.createObjectURL(new Blob([content.bytes], { type: content.mimeType }));
    setUrl(next);

    return () => URL.revokeObjectURL(next);
  }, [content]);

  return (
    <section className="fastloop-preview" aria-label="Evidence preview">
      <header className="fastloop-heading">
        <h4>{title}</h4>
        <button type="button" onClick={onClose}>
          Close preview
        </button>
      </header>
      {content.mimeType === "text/plain" ? (
        <pre>{new TextDecoder().decode(content.bytes)}</pre>
      ) : url ? (
        <img src={url} alt={`Run evidence: ${title}`} />
      ) : (
        <p role="status">Loading image…</p>
      )}
    </section>
  );
}

function ThreadRuns({ threadId, initialRunId }: { threadId: string; initialRunId?: string }) {
  const rpc = useRpc<typeof uiContract>();
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof list>>>();
  const [selected, setSelected] = useState(initialRunId);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  async function list() {
    return rpc.call("listRuns", { threadId });
  }

  useEffect(() => {
    let closed = false;
    void rpc
      .call("listRuns", { threadId })
      .then((items) => {
        if (closed) return;
        setRuns(items);
        setError(false);
        setSelected((previous) => previous ?? items[0]?.runId);
      })
      .catch(() => {
        if (!closed) setError(true);
      });

    return () => {
      closed = true;
    };
  }, [rpc, threadId, refresh]);

  return (
    <div>
      <div className="fastloop-panel">
        <div className="fastloop-heading">
          <h3>FastLoop</h3>
          <button type="button" onClick={() => setRefresh((value) => value + 1)}>
            Refresh runs
          </button>
        </div>
        {error ? (
          <p role="alert">Runs could not load. Refresh to reconnect.</p>
        ) : !runs ? (
          <p role="status">Loading runs…</p>
        ) : !runs.length ? (
          <p>No runs in this chat yet.</p>
        ) : (
          <label>
            Run
            <select value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.summary ?? run.runId} · {run.state}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {selected ? <RunViewer key={selected} threadId={threadId} runId={selected} /> : null}
    </div>
  );
}

function FastLoopPanel({ threadId, params }: PluginThreadPanelProps) {
  const initial = z.object({ runId: runIdSchema }).safeParse(params);

  return (
    <ThreadRuns
      key={threadId}
      threadId={threadId}
      initialRunId={initial.success ? initial.data.runId : undefined}
    />
  );
}

function RunDirective({ attributes, source, message }: PluginMessageDirectiveProps) {
  const runId = runIdSchema.safeParse(attributes.run);

  if (!runId.success) return <span>{source}</span>;

  return (
    <RunViewer
      key={`${message.threadId}/${runId.data}`}
      threadId={message.threadId}
      runId={runId.data}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "fastloop-runs",
    title: "FastLoop",
    icon: "Play",
    component: FastLoopPanel,
  });
  app.slots.messageDirective({ id: "fastloop-run", component: RunDirective });
});
