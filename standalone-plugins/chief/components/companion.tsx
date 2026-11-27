import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_useAppNavigate,
  useRpc,
  useSdk,
  type ExperimentalThreadCompanionProps,
} from "@omnyo/plugin-sdk/app";
import type { ThreadDelegation, rpcContract } from "../lib/contract.ts";
import {
  HOME_PATH,
  NO_AGENT_TEXT,
  PROVIDERS_HREF,
  companionView,
  type CompanionStep,
  type CompanionView,
} from "./chief-logic.ts";
import { REFRESH_MS, answersCommand } from "./deck-logic.ts";
import { CHIEF_ICON } from "./icon.tsx";
import { SuggestionsOffer } from "./offer.tsx";
import { Button } from "./ui/button.tsx";
import { cn } from "./ui/utils.ts";
import { useChiefChanged } from "./use-chief-changed.ts";
import { errorText, useLoaded } from "./use-loaded.ts";

const TICK_MS = 15_000;

const SMALL = "h-7 px-2.5 text-xs pointer-coarse:h-10";

interface CompanionData {
  chiefThreadId: string | null;
  suggestions: "undecided" | "off" | "on";
  agent: { label: string | null; ready: boolean };
  paused: boolean;
  delegations: ThreadDelegation[];
  steps: CompanionStep[];
  labelFor: (questionId: string, value: string) => string;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  return now;
}

function quoted(delegation: ThreadDelegation, labelFor: CompanionData["labelFor"]): string {
  return `"${delegation.answer.map((value) => labelFor(delegation.questionId, value)).join(", ")}"`;
}

function Shell({ children, showName = true }: { children: ReactNode; showName?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 text-card-foreground">
      {showName ? (
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          <Icon name={CHIEF_ICON} className="size-3" aria-hidden />
          Chief
        </span>
      ) : null}
      {children}
    </div>
  );
}

export function ChiefCard({ threadId, placement }: ExperimentalThreadCompanionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const nav = experimental_useAppNavigate();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tooLate, setTooLate] = useState<string | null>(null);

  const load = useCallback(async (): Promise<CompanionData> => {
    const triage = await rpc.call("thread.triage", { threadId });
    const needsLabels = triage.steps.length > 0 || triage.delegations.length > 0;
    const history = needsLabels ? await sdk.experimental_attention.history({ threadId }) : null;
    const questions = new Map((history?.questions ?? []).map((item) => [item.id, item]));

    const labelFor = (questionId: string, value: string): string =>
      questions.get(questionId)?.question.options.find((option) => option.value === value)?.label ??
      value;

    const steps = triage.steps.map((step): CompanionStep => {
      const question = questions.get(step.questionId);
      const options = question?.question.options ?? [];
      const valid = new Set(options.map((option) => option.value));
      const picked = (step.verdict?.recommendation ?? []).filter((value) => valid.has(value));
      const selected = question?.question.multiSelect === true ? picked : picked.slice(0, 1);

      return {
        verdict: step.verdict,
        failed: step.triageError !== null,
        selected,
        labels: selected.map((value) => labelFor(step.questionId, value)),
        questionId: step.questionId,
        revision: question?.revision ?? 0,
      };
    });

    return {
      chiefThreadId: triage.chiefThreadId,
      suggestions: triage.suggestions,
      agent: triage.agent,
      paused: triage.paused,
      delegations: triage.delegations,
      steps,
      labelFor,
    };
  }, [rpc, sdk, threadId]);

  const { value, refresh } = useLoaded(load, REFRESH_MS);

  useChiefChanged(refresh);

  if (value === null || value.chiefThreadId === threadId) return null;

  const view = companionView({
    suggestions: value.suggestions,
    agentReady: value.agent.ready,
    paused: value.paused,
    delegations: value.delegations,
    steps: value.steps,
    now,
  });

  const run = <T,>(call: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    call()
      .then(refresh, (failure: Error) => setError(errorText(failure)))
      .finally(() => setBusy(false));
  };

  const takeSuggestion = () =>
    run(async () => {
      const answers = value.steps.map((step) => ({
        id: step.questionId,
        revision: step.revision,
        selected: step.selected,
        freeText: null,
      }));

      await sdk.experimental_attention.command({ threadId, command: answersCommand(answers) });
      await Promise.all(
        value.steps.map((step) =>
          rpc.call("outcome.record", {
            cardKey: `question:${step.questionId}`,
            cardKind: "question",
            action: "accept",
            threadId,
            questionIds: [step.questionId],
            chosen: step.selected,
            freeText: null,
            reasonChip: null,
            responseMs: null,
          }),
        ),
      );
    });

  const undo = (delegation: ThreadDelegation) =>
    run(async () => {
      const result = await rpc.call("delegation.undo", { id: delegation.id });

      if (result.state !== "cancelled" && result.state !== "corrected")
        setTooLate(delegation.id);
    });

  const openChief = () => {
    const step = value.steps.find((item) => item.verdict?.authorityLike === true) ?? value.steps[0];
    nav.toPluginPanel(
      HOME_PATH,
      step === undefined ? undefined : { subPath: `question/${step.questionId}` },
    );
  };

  if (view.kind === "hidden") return null;

  if (placement === "toolbar")
    return (
      <ToolbarRow
        view={view}
        busy={busy}
        labelFor={value.labelFor}
        onOpen={openChief}
        onStop={(id) => run(() => rpc.call("delegation.undo", { id }))}
      />
    );

  const errorLine =
    error === null ? null : (
      <p role="alert" className="m-0 text-xs text-destructive-text">
        {error}
      </p>
    );

  switch (view.kind) {
    case "offer":
      return (
        <Shell showName={false}>
          <SuggestionsOffer agent={value.agent} onChanged={refresh} />
        </Shell>
      );
    case "no-agent":
      return (
        <Shell>
          <p className="m-0 text-sm">{NO_AGENT_TEXT}</p>
          <div>
            <Button asChild variant="outline" size="sm" className={SMALL}>
              <a href={PROVIDERS_HREF}>Connect an agent</a>
            </Button>
          </div>
        </Shell>
      );
    case "reading":
      return (
        <Shell>
          <p className="m-0 text-sm text-muted-foreground">Reading the question…</p>
        </Shell>
      );
    case "suggests":
      return (
        <Shell>
          <p className="m-0 text-sm font-medium">Chief suggests: {view.labels.join(", ")}</p>
          <p className="m-0 text-xs text-muted-foreground">
            {view.reason} · <span className="font-medium text-foreground">{view.confidence}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {view.usable ? (
              <Button size="sm" className={SMALL} disabled={busy} onClick={takeSuggestion}>
                Use it
              </Button>
            ) : null}
            <Button
              variant="link"
              size="sm"
              className="h-7 px-0 text-xs underline"
              onClick={openChief}
            >
              Review decision
            </Button>
          </div>
          {errorLine}
        </Shell>
      );
    case "countdown":
      return (
        <Shell>
          <p className="m-0 text-sm">
            The Chief answers {quoted(view.delegation, value.labelFor)} in {view.minutes} min.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className={SMALL}
              disabled={busy}
              onClick={() => run(() => rpc.call("delegation.answerNow", { id: view.delegation.id }))}
            >
              Answer now
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={SMALL}
              disabled={busy}
              onClick={() => run(() => rpc.call("delegation.undo", { id: view.delegation.id }))}
            >
              Stop
            </Button>
          </div>
          {errorLine}
        </Shell>
      );
    case "answered":
      return (
        <Shell>
          {tooLate === view.delegation.id ? (
            <p className="m-0 text-sm">The chat already moved on.</p>
          ) : (
            <>
              <p className="m-0 text-sm">
                Answered by the Chief using your rule &quot;{view.delegation.cue}&quot;.
              </p>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  className={SMALL}
                  disabled={busy}
                  onClick={() => undo(view.delegation)}
                >
                  Undo
                </Button>
              </div>
            </>
          )}
          {errorLine}
        </Shell>
      );
  }
}

function ToolbarRow({
  view,
  busy,
  labelFor,
  onOpen,
  onStop,
}: {
  view: Exclude<CompanionView, { kind: "hidden" }>;
  busy: boolean;
  labelFor: CompanionData["labelFor"];
  onOpen: () => void;
  onStop: (id: string) => void;
}) {
  const row = "flex h-7 max-w-full min-w-0 items-center gap-1.5 text-xs";
  const tiny = "h-6 px-2 text-xs";

  const text = (body: string) => (
    <button
      type="button"
      className={cn(row, "cursor-pointer rounded-md bg-transparent px-2 hover:bg-state-hover")}
      onClick={onOpen}
    >
      <span className="shrink-0 font-medium">Chief:</span>
      <span className="truncate">{body}</span>
    </button>
  );

  switch (view.kind) {
    case "offer":
      return (
        <Button variant="ghost" size="sm" className={tiny} onClick={onOpen}>
          Answer suggestions…
        </Button>
      );
    case "no-agent":
      return text(NO_AGENT_TEXT);
    case "reading":
      return text("Reading the question…");
    case "suggests":
      return text(view.labels.join(", "));
    case "countdown":
      return (
        <div className={row}>
          <span className="truncate">
            The Chief answers {quoted(view.delegation, labelFor)} in {view.minutes} min.
          </span>
          <Button
            variant="outline"
            size="sm"
            className={tiny}
            disabled={busy}
            onClick={() => onStop(view.delegation.id)}
          >
            Stop
          </Button>
        </div>
      );
    case "answered":
      return text(`Answered using your rule "${view.delegation.cue}"`);
  }
}
