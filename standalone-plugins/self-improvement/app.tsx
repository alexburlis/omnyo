import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalSidebarFooterDisclosureController,
  type ExperimentalSidebarFooterDisclosureProps,
  experimental_useAppContext,
  experimental_useAppNavigate,
  useRpc,
  useSdk,
} from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import { configSchema, type Config, type Target, type rpcContract } from "./contract";
import {
  captureSelection,
  pickTarget,
  selectionName,
  withSelectionContext,
  type Selection,
} from "./selection";
import { Button } from "./components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Icon } from "./components/ui/icon";
import "./app.css";

const icon = "self-improvement/improve";

const blockedEvents = ["pointerdown", "mousedown", "mouseup", "dblclick", "contextmenu"];

const gestureEvents = [...blockedEvents, "pointerup", "click"];

type Picking = { kind: "picking"; hint: HTMLElement; trigger: Element | null };

type Draft = { kind: "draft"; selection: Selection; pick: number; session: string };

type PickerState = { kind: "idle" } | Picking | Draft;

type Defaults = { data: { config: Config | null; targets: Target[] } | null; error: string };

let state: PickerState = { kind: "idle" };

let picks = 0;

let session = crypto.randomUUID();

let footer: ExperimentalSidebarFooterDisclosureController | null = null;

const listeners = new Set<() => void>();

function publish(next: PickerState) {
  state = next;

  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function usePicker() {
  return useSyncExternalStore(subscribe, () => state);
}

function stopPicking() {
  footer?.close();

  if (state.kind === "picking") publish({ kind: "idle" });
}

function pickAgain() {
  publish({ kind: "idle" });
  footer?.open();
}

function closeDraft() {
  session = crypto.randomUUID();
  publish({ kind: "idle" });
}

function swallowGesture() {
  const controller = new AbortController();

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  for (const type of gestureEvents)
    document.addEventListener(type, swallow, { capture: true, signal: controller.signal });
  window.setTimeout(() => controller.abort(), 500);
}

function pick(element: Element, threadId: string | null) {
  try {
    const selection = captureSelection(pickTarget(element), location.pathname, threadId);
    picks += 1;
    publish({ kind: "draft", selection, pick: picks, session });
    footer?.close();
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : "Could not select this element.");
  }
}

function disclosureTrigger(hint: HTMLElement): Element | null {
  for (let region = hint.parentElement; region; region = region.parentElement) {
    if (!region.id) continue;
    const trigger = document.querySelector(`[aria-controls="${CSS.escape(region.id)}"]`);

    if (trigger) return trigger;
  }

  return null;
}

function passesThrough(target: EventTarget | null, picking: Picking): boolean {
  return (
    target instanceof Element &&
    (target.closest("[data-self-improvement], [data-sidebar-mobile-backdrop]") !== null ||
      target.contains(picking.hint) ||
      (picking.trigger?.contains(target) ?? false))
  );
}

function HintContent({ onStop }: { onStop: () => void }) {
  return (
    <>
      <Icon name={icon} className="size-4 shrink-0 text-primary" aria-hidden />
      <span role="status" className="min-w-0 flex-1">
        Click what you want to change
      </span>
      <Button variant="ghost" size="sm" aria-keyshortcuts="Escape" onClick={onStop}>
        Stop
      </Button>
    </>
  );
}

function PickHint({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hint = ref.current;

    if (!hint) return;
    publish({ kind: "picking", hint, trigger: disclosureTrigger(hint) });

    return () => {
      if (state.kind === "picking" && state.hint === hint) publish({ kind: "idle" });
    };
  }, []);

  return (
    <div
      ref={ref}
      data-self-improvement=""
      className="flex items-center gap-2.5 py-1 pr-1 pl-2.5 text-sm text-foreground"
    >
      <HintContent onStop={dismiss} />
    </div>
  );
}

function PickerLayer({ picking }: { picking: Picking }) {
  const context = experimental_useAppContext();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hintVisible, setHintVisible] = useState(true);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setHintVisible(entry?.isIntersecting ?? false),
    );

    observer.observe(picking.hint);

    return () => observer.disconnect();
  }, [picking.hint]);

  useEffect(() => {
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    let hovered: Element | null = null;

    const highlight = (target: Element | null) => {
      hovered = target;
      setRect(target?.isConnected ? target.getBoundingClientRect() : null);
    };

    const block = (event: Event) => {
      if (passesThrough(event.target, picking)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    document.documentElement.toggleAttribute("data-self-improvement-picking", true);
    document.addEventListener(
      "pointermove",
      (event) => {
        const target = document.elementFromPoint(event.clientX, event.clientY);
        highlight(target && !passesThrough(target, picking) ? pickTarget(target) : null);
      },
      options,
    );
    document.addEventListener("scroll", () => highlight(hovered), options);

    for (const type of blockedEvents) document.addEventListener(type, block, options);
    document.addEventListener(
      "pointerup",
      (event) => {
        if (passesThrough(event.target, picking) || !(event.target instanceof Element)) return;
        block(event);

        if (event.button !== 0) return;
        swallowGesture();
        pick(event.target, context.threadId);
      },
      options,
    );
    document.addEventListener(
      "click",
      (event) => {
        if (passesThrough(event.target, picking) || !(event.target instanceof Element)) return;
        block(event);

        if (event.detail === 0) pick(event.target, context.threadId);
      },
      options,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        stopPicking();
      },
      options,
    );

    return () => {
      controller.abort();
      document.documentElement.removeAttribute("data-self-improvement-picking");
    };
  }, [picking, context.threadId]);

  return (
    <div data-self-improvement="" className="self-improvement-picker">
      {rect && (
        <div
          className="self-improvement-outline"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      )}
      {!hintVisible && (
        <div className="self-improvement-floating-hint flex items-center gap-2.5 rounded-lg border border-border bg-popover py-1 pr-1 pl-2.5 text-sm text-popover-foreground shadow-md">
          <HintContent onStop={stopPicking} />
        </div>
      )}
    </div>
  );
}

function useDefaults(active: boolean): Defaults {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Defaults["data"]>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!active) return;
    let current = true;
    setError("");
    Promise.all([rpc.call("config", null), rpc.call("targets", null)]).then(
      ([config, targets]) => {
        if (current) setData({ config, targets });
      },
      () => {
        if (current) setError("Could not load chat defaults. Try again.");
      },
    );

    return () => {
      current = false;
    };
  }, [active, rpc]);

  return { data, error };
}

function DraftComposer({ draft, defaults }: { draft: Draft; defaults: Defaults }) {
  const sdk = useSdk();
  const navigate = experimental_useAppNavigate();

  if (defaults.data === null)
    return defaults.error ? (
      <p role="alert" className="text-sm text-destructive">
        {defaults.error}
      </p>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  const { config, targets } = defaults.data;
  const target = targets.find((candidate) => candidate.id === config?.environmentId);

  if (config !== null && !target)
    return (
      <p role="alert" className="text-sm">
        Choose an available folder in Settings → Plugins → Omnyo Customizer.
      </p>
    );

  return (
    <NewThreadComposer
      draftKey={`improve-${draft.session}`}
      layout="document"
      defaultProjectId={target?.projectId}
      defaultEnvironment={target ? { type: "reuse", environmentId: target.id } : undefined}
      defaultProviderId={config?.providerId}
      defaultModel={config?.model}
      defaultReasoningLevel={config?.reasoningLevel}
      defaultServiceTier={config ? "default" : undefined}
      placeholder="What should change?"
      focusRequest={draft.pick}
      onSubmit={async (request) => {
        try {
          const result = await sdk.threads.spawn({
            ...request,
            input: withSelectionContext(request.input, draft.selection),
          });

          closeDraft();
          navigate.toThread(result.id);
        } catch (cause) {
          toast.error("Could not start the chat. Try again.");
          throw cause;
        }
      }}
    />
  );
}

function ImproveDialog({ draft, defaults }: { draft: Draft | null; defaults: Defaults }) {
  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open && state.kind === "draft") closeDraft();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="max-w-2xl gap-3"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Change this part of Omnyo</DialogTitle>
        </DialogHeader>
        {draft && (
          <>
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-3 text-sm">
              <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <code className="shrink-0 font-mono text-xs text-muted-foreground">
                {`<${draft.selection.tag}>`}
              </code>
              <span className="min-w-0 flex-1 truncate">
                {selectionName(draft.selection) || "No visible text"}
              </span>
              <Button variant="ghost" size="sm" onClick={pickAgain}>
                Pick again
              </Button>
            </div>
            <DraftComposer draft={draft} defaults={defaults} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Overlay() {
  const picker = usePicker();
  const defaults = useDefaults(picker.kind !== "idle");

  return (
    <>
      {picker.kind === "picking" && <PickerLayer picking={picker} />}
      <ImproveDialog draft={picker.kind === "draft" ? picker : null} defaults={defaults} />
    </>
  );
}

function DefaultsForm({ initial, targets }: { initial: Config; targets: Target[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const [saved, setSaved] = useState(false);
  const failed = message !== "" && !saved;

  return (
    <form
      className="flex max-w-xl flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setMessage("");
        setSaved(false);

        try {
          await rpc.call("save", config);
          setSaved(true);
          setMessage("Defaults saved.");
        } catch {
          setMessage("Could not save defaults. Try again.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        When you pick part of Omnyo with the Customizer, the New chat dialog it opens starts in this
        folder with this model. Until you save, the dialog uses the composer&rsquo;s usual project
        and model.
      </p>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Chat folder</span>
        <span className="relative flex">
          <select
            aria-label="Chat folder"
            className="h-9 w-full cursor-pointer appearance-none truncate rounded-md border border-input bg-background pr-9 pl-3 text-sm text-foreground hover:border-ring/40 focus-visible:border-ring/60 focus-visible:outline-3 focus-visible:outline-offset-0 focus-visible:outline-ring/15"
            value={config.environmentId}
            onChange={(event) => {
              setConfig({ ...config, environmentId: event.target.value });
              setSaved(false);
              setMessage("");
            }}
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.path}
                {target.name !== target.path ? ` · ${target.name}` : ""}
              </option>
            ))}
          </select>
          <Icon
            name="ChevronDown"
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </span>
        <span className="text-xs text-muted-foreground">
          In a folder that is not Omnyo&rsquo;s source, the chat is asked to make the change with
          settings, a theme or a plugin.
        </span>
      </label>
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-foreground">Default model</span>
        <ProviderModelPicker
          routing={{ kind: "environment", environmentId: config.environmentId }}
          value={config}
          onChange={(value) => {
            setConfig(configSchema.parse({ ...value, environmentId: config.environmentId }));
            setSaved(false);
            setMessage("");
          }}
        />
      </div>
      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button type="submit" className="w-fit" disabled={saving || config.model === ""}>
          {saving ? "Saving…" : "Save defaults"}
        </Button>
        {message && (
          <p
            role="status"
            className={`flex items-center gap-1.5 text-sm ${failed ? "text-destructive-text" : "text-muted-foreground"}`}
          >
            <Icon
              name={failed ? "AlertCircle" : "CircleCheck"}
              aria-hidden="true"
              className={`size-4 ${failed ? "" : "text-success"}`}
            />
            {message}
          </p>
        )}
      </div>
    </form>
  );
}

function initialConfig(saved: Config | null, targets: Target[]): Config {
  if (saved !== null && targets.some((target) => target.id === saved.environmentId)) return saved;

  return {
    environmentId: targets[0]?.id ?? "",
    providerId: saved?.providerId ?? "",
    model: saved?.model ?? "",
    reasoningLevel: saved?.reasoningLevel ?? "medium",
  };
}

function Settings() {
  const { data, error } = useDefaults(true);

  if (error) return <p role="alert">{error}</p>;

  if (data === null) return <p role="status">Loading…</p>;

  if (data.targets.length === 0)
    return <p role="status">Add a project folder to Omnyo, then choose it here.</p>;

  return <DefaultsForm initial={initialConfig(data.config, data.targets)} targets={data.targets} />;
}

export default definePluginApp((app) => {
  footer = app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "select",
    label: "Omnyo Customizer: pick what to change",
    icon,
    component: PickHint,
  });
  app.slots.experimental_appOverlay({ id: "picker", component: Overlay });
  app.slots.settingsSection({ id: "defaults", title: "Chat defaults", component: Settings });
});
