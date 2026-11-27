import {
  Markdown,
  experimental_Icon as Icon,
  experimental_useAppNavigate,
} from "@omnyo/plugin-sdk/app";

import type { AttentionItem } from "../data/contract.js";
import { Button } from "../primitives.js";

type Cause = NonNullable<AttentionItem["cause"]>;

export function describeOutcome(outcome: string): string {
  if (outcome.startsWith("result."))
    return `returned “${outcome.slice("result.".length).replaceAll("-", " ")}”`;

  switch (outcome) {
    case "timed-out":
      return "timed out";
    case "no-result":
      return "ended without a result";
    case "cancelled":
      return "was cancelled";
    case "budget-exhausted":
      return "used all its repair rounds";
    case "uncertain":
      return "has an unknown outcome";
    default:
      return outcome;
  }
}

export function HomeChatButton({ threadId }: { threadId: string }) {
  const navigate = experimental_useAppNavigate();

  return (
    <Button
      variant="secondary"
      icon="MessageSquare"
      onClick={() => navigate.toThread(threadId, { split: true })}
    >
      Open home chat
    </Button>
  );
}

type CauseTone = "danger" | "attention" | "info";

const CAUSE_ICON: Record<CauseTone, string> = {
  danger: "CircleX",
  attention: "AlertTriangle",
  info: "Pause",
};

export function causeTone(outcome: string): CauseTone {
  if (outcome.startsWith("result.")) return "info";

  switch (outcome) {
    case "failed":
    case "timed-out":
    case "cancelled":
    case "budget-exhausted":
      return "danger";
    default:
      return "attention";
  }
}

function CauseSummary({ cause }: { cause: Cause }) {
  const navigate = experimental_useAppNavigate();
  const stepThreadId = cause.threadId;
  const tone = causeTone(cause.outcome);

  return (
    <section className={`stm-cause stm-cause--${tone}`}>
      <span className="stm-cause-glyph" aria-hidden="true">
        <Icon name={CAUSE_ICON[tone]} fallback="Circle" />
      </span>
      <div className="stm-cause-main">
        <p className="stm-cause-eyebrow">Step {describeOutcome(cause.outcome)}</p>
        <p className="stm-cause-title">{cause.stateTitle}</p>
        {cause.reason === null ? null : <p className="stm-cause-reason">{cause.reason}</p>}
        {stepThreadId === null ? null : (
          <button
            type="button"
            className="stm-cause-link"
            onClick={() => navigate.toThread(stepThreadId, { split: true })}
          >
            <Icon name="MessageSquare" fallback="Circle" aria-hidden />
            Open step chat
            <Icon
              name="ChevronRight"
              fallback="Circle"
              aria-hidden
              className="stm-cause-link-arrow"
            />
          </button>
        )}
      </div>
    </section>
  );
}

export function AttentionContext({
  item,
}: {
  item: Pick<AttentionItem, "bodyMarkdown" | "cause" | "kind">;
}) {
  const body =
    item.bodyMarkdown === "" || item.bodyMarkdown === item.cause?.reason ? null : (
      <div className="stm-attention-body">
        <Markdown content={item.bodyMarkdown} />
      </div>
    );

  return (
    <>
      {item.cause === null ? null : <CauseSummary cause={item.cause} />}
      {item.kind === "gate" && item.cause !== null && body !== null ? (
        <details className="stm-attention-details">
          <summary>
            <Icon
              name="ChevronRight"
              fallback="Circle"
              aria-hidden
              className="stm-disclosure-icon"
            />
            Decision details
          </summary>
          {body}
        </details>
      ) : (
        body
      )}
    </>
  );
}
