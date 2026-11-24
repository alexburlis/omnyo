import { useEffect, useMemo, useState } from "react";
import type { ExperimentalComposerSuggestion } from "@omnyo/plugin-sdk";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@omnyo/client-core";
import { Button } from "@omnyo/shared-ui/button";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  PluginComposerHostProvider,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { setComposerSuggestion } from "@/lib/composer-suggestions";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
} from "./PromptBoxInternal";

const SHORT_TEXT =
  "Update the README to describe the new composer suggestion, then commit and push.";

const LONG_TEXT = `Looks good.

Before pushing:
- check the iPad layout
- run the composer tests again`;

function SuggestionComposer({
  storyKey,
  suggestion,
  compact = false,
  blockedReason,
}: {
  storyKey: string;
  suggestion: ExperimentalComposerSuggestion | null;
  compact?: boolean;
  blockedReason?: string;
}) {
  const [value, setValue] = useState("");
  const [sent, setSent] = useState<readonly string[]>([]);
  const [focusNonce, setFocusNonce] = useState(0);

  useEffect(() => {
    const owner = Symbol(storyKey);
    setComposerSuggestion(storyKey, "story", suggestion, owner, 0);

    return () => setComposerSuggestion(storyKey, "story", null, owner, 0);
  }, [storyKey, suggestion]);

  const host = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId: "thr_story" },
      textEffectKey: storyKey,
      getCurrent: () => ({ text: value, mentions: [], attachments: [] }),
      subscribeDraft: () => () => {},
      setDraft: (next) => setValue(next.text),
      focus: () => setFocusNonce((nonce) => nonce + 1),
      submitDraft: async (draft) => {
        setSent((current) => [...current, draft.text]);
      },
    }),
    [storyKey, value],
  );

  return (
    <CompactViewportOverrideProvider isCompactViewport={compact}>
      <div
        className={
          compact
            ? "mx-auto flex w-full max-w-[390px] flex-col gap-4 p-3"
            : "mx-auto flex w-full max-w-[44rem] flex-col gap-4 p-6"
        }
      >
        <p className="text-sm leading-relaxed text-foreground">
          Fixed the stale completion assessment. Typecheck and both focused
          tests pass. The README still describes the old card.
        </p>
        {sent.map((text, index) => (
          <p
            key={index}
            data-story-sent=""
            className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3 py-1.5 text-sm"
          >
            {text}
          </p>
        ))}
        <PluginComposerHostProvider value={host}>
          <PromptBoxInternal
            value={value}
            mentionRanges={[]}
            onChange={(next) => setValue(next)}
            onSubmit={() => {
              setSent((current) => [...current, value]);
              setValue("");
            }}
            mentionMenuPlacement="top"
            autoFocus={false}
            focusEndKey={focusNonce}
            placeholder="Ask for a follow-up"
            onCollapse={compact ? undefined : () => {}}
            compact={
              compact
                ? { isCompact: value === "", placeholder: "Reply" }
                : undefined
            }
            submission={
              blockedReason === undefined
                ? undefined
                : { disabled: true, disabledReason: blockedReason }
            }
            typeahead={{
              mention: {
                results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
                isLoading: false,
                isRefreshing: false,
                isError: false,
                onQueryChange: () => {},
              },
              command: INERT_TYPEAHEAD_COMMAND_CONFIG,
            }}
          />
        </PluginComposerHostProvider>
      </div>
    </CompactViewportOverrideProvider>
  );
}

export default { title: "composer/Suggested reply" };

const dismiss = () => {};

const regenerate = () => {};

const READY_SHORT: ExperimentalComposerSuggestion = {
  status: "ready",
  text: SHORT_TEXT,
  onDismiss: dismiss,
  onRegenerate: regenerate,
};

const READY_LONG: ExperimentalComposerSuggestion = {
  status: "ready",
  text: LONG_TEXT,
  onDismiss: dismiss,
  onRegenerate: regenerate,
};

const LOADING: ExperimentalComposerSuggestion = {
  status: "loading",
  onDismiss: dismiss,
};

const FAILED: ExperimentalComposerSuggestion = {
  status: "failed",
  message: "Predictions need fresh included Codex allowance.",
  onRetry: () => {},
  onDismiss: dismiss,
};

const NONE: ExperimentalComposerSuggestion = {
  status: "none",
  reason: "A pursue loop already owns the next step.",
  onRequest: () => {},
  onDismiss: dismiss,
};

export const Ready = () => (
  <SuggestionComposer storyKey="story:ready" suggestion={READY_SHORT} />
);

export const ReadyLong = () => (
  <SuggestionComposer storyKey="story:ready-long" suggestion={READY_LONG} />
);

export const Loading = () => (
  <SuggestionComposer storyKey="story:loading" suggestion={LOADING} />
);

export const Failed = () => (
  <SuggestionComposer storyKey="story:failed" suggestion={FAILED} />
);

export const NoSuggestion = () => (
  <SuggestionComposer storyKey="story:none" suggestion={NONE} />
);

export const CompactReady = () => (
  <SuggestionComposer
    storyKey="story:compact-ready"
    suggestion={READY_SHORT}
    compact
  />
);

export const CompactLoading = () => (
  <SuggestionComposer
    storyKey="story:compact-loading"
    suggestion={LOADING}
    compact
  />
);

export const CompactReadyLong = () => (
  <SuggestionComposer
    storyKey="story:compact-ready-long"
    suggestion={READY_LONG}
    compact
  />
);

export const CompactSendBlocked = () => (
  <SuggestionComposer
    storyKey="story:compact-send-blocked"
    suggestion={READY_SHORT}
    compact
    blockedReason="The Mac running this chat is offline."
  />
);

export const CompactFailed = () => (
  <SuggestionComposer
    storyKey="story:compact-failed"
    suggestion={FAILED}
    compact
  />
);

const STATE_CHANGE_SUGGESTIONS = {
  hidden: null,
  loading: LOADING,
  ready: READY_SHORT,
  failed: FAILED,
} as const;

type StateChangeKey = keyof typeof STATE_CHANGE_SUGGESTIONS;

const STATE_CHANGE_KEYS: readonly StateChangeKey[] = [
  "hidden",
  "loading",
  "ready",
  "failed",
];

const STATE_CHANGE_LABELS: Record<StateChangeKey, string> = {
  hidden: "Hidden",
  loading: "Loading",
  ready: "Ready",
  failed: "Failed",
};

export const CompactStateChanges = () => {
  const [state, setState] = useState<StateChangeKey>("hidden");

  return (
    <div className="flex flex-col">
      <div
        role="group"
        aria-label="Suggestion state"
        className="mx-auto flex w-full max-w-[390px] flex-wrap gap-1 px-3 pt-3"
      >
        {STATE_CHANGE_KEYS.map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={state === key}
            data-story-state={key}
            onClick={() => setState(key)}
          >
            {STATE_CHANGE_LABELS[key]}
          </Button>
        ))}
      </div>
      <SuggestionComposer
        storyKey="story:compact-state-changes"
        suggestion={STATE_CHANGE_SUGGESTIONS[state]}
        compact
      />
    </div>
  );
};
