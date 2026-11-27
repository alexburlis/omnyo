import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_useAppContext,
  experimental_useAppNavigate,
  useRealtime,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { JobView } from "./contracts";
import { Button } from "./components/ui/button";

function QueuesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = experimental_useAppNavigate();
  const context = experimental_useAppContext();
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void rpc.call("status").then(
      (value) => {
        setJobs(value.jobs);
        setEnabled(value.enabled);
        setError(null);
      },
      () => setError("Could not load queue routes."),
    );
  }, [rpc]);

  useEffect(refresh, [refresh]);
  useRealtime("routes-changed", refresh);

  return (
    <div className="h-full overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold">Smart Queues</h1>
            <p className="text-sm text-muted-foreground">
              Automatic routing is {enabled ? "on" : "off"}.
            </p>
          </div>
          <Button variant="outline" onClick={refresh}>
            Refresh
          </Button>
        </div>
        {context.threadId ? (
          <Button
            onClick={() => {
              void rpc
                .call("classify", { threadId: context.threadId! })
                .then(refresh, () =>
                  setError("Could not route this queue. Messages remain queued."),
                );
            }}
          >
            Route this queue
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {jobs === null ? (
          <p role="status">Loading routes…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Routes appear here when messages queue behind a busy chat.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border px-4">
            {jobs.map((job) => (
              <li key={job.id} className="space-y-2 py-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">
                    {job.action === "new-chat"
                      ? "New chat"
                      : job.action === "steer"
                        ? "Steered"
                        : job.action === "combine"
                          ? "Combined"
                          : job.action === "queue"
                            ? "Queued"
                            : "Routing"}{" "}
                    · {job.count} {job.count === 1 ? "message" : "messages"}
                  </span>
                  <span className="text-xs text-muted-foreground">{job.state}</span>
                </div>
                <p className="text-muted-foreground">{job.reason}</p>
                {job.error ? <p role="alert">{job.error}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate.toThread(job.threadId)}
                  >
                    Source chat
                  </Button>
                  {job.destinationThreadId ? (
                    <Button size="sm" onClick={() => navigate.toThread(job.destinationThreadId!)}>
                      Open new chat
                    </Button>
                  ) : null}
                  {job.state === "error" && job.destinationThreadId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void rpc
                          .call("restore", { id: job.id })
                          .then(refresh, () =>
                            setError(
                              "Some receipts changed or were consumed. Inspect the retained destination.",
                            ),
                          );
                      }}
                    >
                      Restore source
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "routes",
    title: "Smart Queues",
    icon: "Workflow",
    path: "routes",
    component: QueuesPage,
  });
});
