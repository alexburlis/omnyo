import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  useRpc,
  useSettings,
  type PluginComposerApi,
} from "@omnyo/plugin-sdk/app";
import { type rpcContract, type VoiceStatus } from "./contract";

const STATE_BADGES: Record<VoiceStatus["state"], { label: string; dot: string }> = {
  ready: { label: "Ready", dot: "bg-success" },
  downloading: { label: "Downloading", dot: "bg-warning" },
  download_required: { label: "Download needed", dot: "border-[1.5px] border-subtle-foreground" },
  download_failed: { label: "Download failed", dot: "bg-destructive" },
  unavailable: { label: "Unavailable", dot: "bg-warning" },
};

function SpeechModel() {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const dictionary = values?.dictionary;

  const load = useCallback(async () => {
    try {
      setStatus(await rpc.call("status", null));
      setProblem(null);
    } catch {
      setProblem("Dictation by Paraspeech couldn't check the speech model.");
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load, dictionary]);

  const downloading = status?.state === "downloading";
  const waiting = status === null || downloading || status.state === "unavailable";

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), downloading ? 2_000 : 5_000);

    return () => window.clearInterval(timer);
  }, [waiting, downloading, load]);

  async function download() {
    setStarting(true);
    setProblem(null);

    try {
      setStatus(await rpc.call("download", null));
    } catch {
      setProblem("The download couldn't start. Try again.");
    } finally {
      setStarting(false);
    }
  }

  const action =
    status?.state === "download_required"
      ? "Download model"
      : status?.state === "download_failed"
        ? "Try again"
        : status?.state === "downloading"
          ? "Downloading…"
          : null;

  const badge = status === null ? null : STATE_BADGES[status.state];

  return (
    <div className="flex flex-col gap-3 text-sm">
      {status !== null && badge !== null ? (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
          <span
            aria-hidden="true"
            className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${badge.dot}`}
          />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">{badge.label}</p>
            <p className="mt-0.5 text-muted-foreground" role="status">
              {status.message}
            </p>
          </div>
          {action ? (
            <button
              type="button"
              className="h-8 shrink-0 cursor-pointer rounded-md bg-foreground px-3 text-xs font-medium text-background transition-colors duration-(--motion-duration-fast) hover:bg-foreground/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60 disabled:pointer-events-none disabled:opacity-50"
              disabled={starting || downloading}
              onClick={() => void download()}
            >
              {action}
            </button>
          ) : null}
        </div>
      ) : problem ? null : (
        <p className="text-muted-foreground" role="status">
          Checking the speech model…
        </p>
      )}
      {problem ? (
        <p
          className="rounded-lg border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-destructive-text"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  const prompts = new WeakMap<PluginComposerApi, Element>();

  app.slots.settingsSection({ id: "speech-model", title: "Speech model", component: SpeechModel });

  app.composer.experimental_registerCommand({
    id: "toggle-recording",
    title: "Dictation by Paraspeech: Toggle recording",
    defaultShortcut: { key: "d", control: true },
    run: async ({ composer }) => {
      composer.focus();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const focused = document.activeElement?.closest("[data-promptbox]");

      if (focused) prompts.set(composer, focused);
      // Omnyo blurs and locks the editor while recording; retain this composer's controls.
      const prompt = focused ?? prompts.get(composer);

      if (!prompt?.isConnected) return;

      const label = prompt.hasAttribute("data-promptbox-voice-active")
        ? "Stop and add to draft"
        : "Start voice input";

      const button = prompt.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

      if (button && !button.disabled && !button.closest("[inert]")) button.click();
    },
  });
});
