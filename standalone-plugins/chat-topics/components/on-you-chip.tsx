import { chatTapOptions } from "../lib/chat-tap.ts";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  experimental_useAppNavigate,
  experimental_useInboxSnapshot,
  useComposer,
  useSdk,
} from "@omnyo/plugin-sdk/app";
import { matchOnYou, onYouCandidates } from "../lib/on-you.ts";

export function OnYouChip() {
  const composer = useComposer();
  const sdk = useSdk();
  const navigate = experimental_useAppNavigate();
  const { snapshot } = experimental_useInboxSnapshot();

  const candidates = useMemo(
    () => (snapshot === null ? null : onYouCandidates(snapshot)),
    [snapshot],
  );

  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<{ waitId: string; text: string } | null>(null);
  const match = candidates === null ? null : matchOnYou(composer.text, candidates, dismissed);

  if (match === null) return null;

  const plain = composer.draft.mentions.length === 0 && composer.attachmentCount === 0;

  const sendThere = () => {
    const text = composer.text;
    setFailed(null);
    composer.replace({ text: "", mentions: [] });
    navigate.toThread(match.threadId);

    sdk.threads
      .send({
        threadId: match.threadId,
        input: [{ type: "text", text, mentions: [] }],
        mode: "auto",
      })
      .catch(() => {
        composer.insert(text, { at: "end", block: true });
        setFailed({ waitId: match.waitId, text });
        toast.error("The reply was not sent. Your draft was restored in the original chat.");
      });
  };

  return (
    <div className="ct-on-you" role="status">
      <span className="ct-on-you-text">On you: {match.event}</span>
      {plain ? (
        <button type="button" className="ct-on-you-action" onClick={sendThere}>
          Send there instead
        </button>
      ) : (
        <button
          type="button"
          className="ct-on-you-action"
          onClick={() => navigate.toThread(match.threadId, chatTapOptions())}
        >
          Open {match.title}
        </button>
      )}
      {failed?.waitId === match.waitId && failed.text === composer.text ? (
        <span className="ct-on-you-error">Not sent; your draft is still here.</span>
      ) : null}
      <button
        type="button"
        className="ct-on-you-dismiss"
        aria-label="Dismiss"
        onClick={() => {
          setFailed(null);
          setDismissed(new Set([...dismissed, match.waitId]));
        }}
      >
        ×
      </button>
    </div>
  );
}
