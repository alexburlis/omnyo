import { useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { WaveformVisualizer } from "./WaveformVisualizer.js";

interface VoiceRecordingBarProps {
  isCompact: boolean;
  state: "starting" | "recording" | "transcribing";
  stream: MediaStream | null;
  microphoneWarning: string | null;
  submitIcon: IconName;
  onConfirm: () => void;
  onSend: () => void;
  onCancel: () => void;
}

const CONTROL_BUTTON_CLASS =
  "size-8 rounded-full p-0 max-md:pointer-coarse:size-10";

const ACTION_BUTTON_CLASS =
  "size-8 rounded-md p-0 max-md:pointer-coarse:size-10";

export function VoiceRecordingBar({
  isCompact,
  state,
  stream,
  microphoneWarning,
  submitIcon,
  onConfirm,
  onSend,
  onCancel,
}: VoiceRecordingBarProps) {
  const [pressedAction, setPressedAction] = useState<"confirm" | "send">(
    "confirm",
  );

  const isStarting = state === "starting";
  const isTranscribing = state === "transcribing";
  const isPending = isStarting || isTranscribing;

  const isConfirming =
    isStarting || (isTranscribing && pressedAction === "confirm");

  const isSending = isTranscribing && pressedAction === "send";

  return (
    <div
      className={cn(
        "flex flex-row items-center gap-2 px-2",
        isCompact ? "h-full py-1" : "py-1.5",
      )}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={
          isStarting
            ? "Cancel voice input"
            : isTranscribing
              ? "Cancel transcription"
              : "Cancel recording"
        }
        onClick={onCancel}
        className={CONTROL_BUTTON_CLASS}
      >
        <Icon name="X" className="size-4" />
      </Button>
      <div className="relative flex min-w-0 flex-1 items-center">
        <div className={cn("h-7 w-full", isPending && "animate-shine-icon")}>
          <WaveformVisualizer stream={stream} active={!isPending} />
        </div>
        <span className="sr-only" aria-live="polite">
          {isStarting
            ? "Starting microphone"
            : isTranscribing
              ? "Transcribing"
              : "Recording"}
        </span>
      </div>
      {state === "recording" && microphoneWarning ? (
        <span role="status" className="sr-only">
          {microphoneWarning}
        </span>
      ) : null}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label={
                isStarting
                  ? "Starting voice input"
                  : isConfirming
                    ? "Transcribing voice input"
                    : "Stop and add to draft"
              }
              disabled={isPending}
              onClick={() => {
                setPressedAction("confirm");
                onConfirm();
              }}
              className={cn(
                ACTION_BUTTON_CLASS,
                isConfirming && "disabled:opacity-100",
              )}
            >
              {isConfirming ? (
                <Icon name="Spinner" className="size-4 animate-spin" />
              ) : (
                <Icon
                  name="Square"
                  className="size-3.5 fill-current [&_*]:stroke-0"
                />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Add to draft</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="default"
              aria-label={
                isSending ? "Transcribing and sending" : "Send voice input"
              }
              disabled={isPending}
              onClick={() => {
                setPressedAction("send");
                onSend();
              }}
              className={cn(
                ACTION_BUTTON_CLASS,
                isSending && "disabled:opacity-100",
              )}
            >
              {isSending ? (
                <Icon name="Spinner" className="size-4 animate-spin" />
              ) : (
                <Icon name={submitIcon} className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Send</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
