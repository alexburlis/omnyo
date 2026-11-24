import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";

const INCOMING_PROMPT_TITLE = "Use this prompt?";

const INCOMING_PROMPT_SOURCE = "From a link";

const INCOMING_PROMPT_CLIPPED_NOTE = "Scroll to read all of it.";

interface RootComposeIncomingPromptProps {
  text: string;
  onUse: () => void;
  onDismiss: () => void;
}

export function RootComposeIncomingPrompt({
  text,
  onUse,
  onDismiss,
}: RootComposeIncomingPromptProps) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;

    if (element === null) return;

    const measure = () => {
      setClipped(element.scrollHeight > element.clientHeight);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [text]);

  return (
    <PromptStackCard ariaLabel={INCOMING_PROMPT_TITLE} className="mb-2">
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="text-xs font-medium text-foreground">
          {INCOMING_PROMPT_TITLE}
        </p>
        <p className="text-xs text-subtle-foreground">
          {clipped
            ? `${INCOMING_PROMPT_SOURCE}. ${INCOMING_PROMPT_CLIPPED_NOTE}`
            : INCOMING_PROMPT_SOURCE}
        </p>
        <p
          ref={textRef}
          className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-snug text-subtle-foreground"
        >
          {text}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
          <Button type="button" size="sm" className="shrink-0" onClick={onUse}>
            Use
          </Button>
        </div>
      </div>
    </PromptStackCard>
  );
}
