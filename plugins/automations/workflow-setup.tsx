import { useState, type FormEvent, type ReactNode } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { FIELD_FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  DISCLOSURE_CHEVRON_TRANSITION,
  getStaggerItemProps,
} from "@/components/ui/motion";
import { StatusBadge, StatusDot } from "@/components/ui/status-row";
import { StepIndicator } from "@/components/ui/step-indicator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { workflowRpcContract } from "./src/workflow-contract";
import {
  productFactLines,
  WEEKLY_FACT_TARGET,
} from "./src/weekly-product-facts";
import { errorMessage, type Copy } from "./workflow-panel-shared";

export type Review = z.output<
  (typeof workflowRpcContract)["workflow_inspect"]["output"]
>;

export type SetupOptions = z.output<
  (typeof workflowRpcContract)["workflow_options"]["output"]
>;

export type InputValues = Record<string, string | number | boolean>;

type WorkflowInput = Copy["package"]["inputs"][number];

export const selectControl =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const nativeSelectControl = cn(
  "h-9 w-full cursor-pointer appearance-none rounded-md border border-input bg-surface-raised pl-3 pr-9 text-sm text-foreground shadow-control disabled:cursor-not-allowed disabled:opacity-50",
  FIELD_FOCUS_RING_CLASS,
);

export function NativeSelect({
  value,
  required,
  disabled,
  onChange,
  children,
}: {
  value: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className="relative block">
      <select
        className={nativeSelectControl}
        required={required}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <Icon
        name="ChevronDown"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </span>
  );
}

const BRIEF_INPUTS = ["startup", "audience", "product-facts"];

const RECIPIENT_INPUTS = new Set([
  ...BRIEF_INPUTS,
  "reference-urls",
  "inventory",
  "example-content",
  "terminology",
  "exclusions",
]);

const SHORT_INPUTS = new Set([
  "startup",
  "audience",
  "terminology",
  "output-language",
  "output-format",
]);

const FIELD_HINTS: Record<string, string> = {
  startup: "The name every draft writes about.",
  audience: "Who reads the drafts, in a short phrase.",
  "product-facts":
    "Drafts use only what you write here, and the reviewer rejects claims that go beyond it.",
  "reference-urls": "Pages the writer may cite. One address per line.",
  inventory: "Topics you have already covered, so drafts avoid repeating them.",
  "example-content": "A piece you like, as a guide to tone and length.",
  terminology: "Words to use for your product and its parts.",
  exclusions: "Anything the drafts must never mention or claim.",
  timezone: "Used for the delivery calendar.",
};

export function isWeeklyFeed(copy: Copy) {
  return (
    copy.package.flow.kind === "graph" &&
    copy.package.flow.engine === "weekly-content-feed"
  );
}

export function initialInputs(copy: Copy | undefined): InputValues {
  if (!copy) return {};
  const saved = copy.bindings?.inputs ?? copy.draftInputs;
  const weekly = isWeeklyFeed(copy);

  if (!weekly && saved) return saved;

  return Object.fromEntries(
    copy.package.inputs.map(({ id, type, default: defaultValue }) => [
      id,
      saved?.[id] ??
        (weekly && RECIPIENT_INPUTS.has(id) && type === "text"
          ? ""
          : (defaultValue ??
            (type === "boolean" ? false : type === "integer" ? 1 : ""))),
    ]),
  );
}

function weekdayName(day: number, width: "short" | "long" = "short") {
  return new Intl.DateTimeFormat("en", {
    weekday: width,
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2027, 0, 3 + (((day - 1) % 7) + 1))));
}

export function triggerSummary(trigger: Copy["package"]["trigger"]) {
  switch (trigger.kind) {
    case "manual":
      return "Runs when you start it";
    case "once":
      return `Runs once on ${new Date(trigger.at).toLocaleString()}`;
    case "schedule":
      return `Runs on schedule ${trigger.cron} · ${trigger.timezone}`;
    case "weekly":
      return `Every ${weekdayName(trigger.weekday === 0 ? 7 : trigger.weekday, "long")} at ${trigger.time} · ${trigger.timezone}`;
  }
}

export function copyStatus(copy: Copy) {
  if (!copy.graphId)
    return { label: "Needs a supported action", tone: "warning" } as const;

  if (!copy.bindings) return { label: "Needs a brief", tone: "muted" } as const;

  if (!copy.confirmation)
    return { label: "Ready to preview", tone: "info" } as const;

  return { label: "Ready to run", tone: "positive" } as const;
}

const PILL_TONE = {
  muted: "pending",
  info: "neutral",
  positive: "success",
  warning: "warning",
} as const;

export function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: keyof typeof PILL_TONE;
}) {
  return (
    <StatusBadge tone={PILL_TONE[tone]} className="gap-1.5">
      <StatusDot tone={PILL_TONE[tone]} className="size-1.5" />
      {label}
    </StatusBadge>
  );
}

export function Panel({
  className,
  children,
  label,
}: {
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "rounded-xl border border-border bg-card p-4 shadow-card md:p-5",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
    >
      <Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

const SETUP_STEPS = [
  { id: "import", label: "Import" },
  { id: "brief", label: "Brief" },
  { id: "preview", label: "Preview" },
  { id: "run", label: "Run" },
] as const;

export function SetupProgress({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <StepIndicator
      steps={SETUP_STEPS}
      currentIndex={current - 1}
      ariaLabel="Setup progress"
      className="max-w-lg"
    />
  );
}

function FactsProgress({ count }: { count: number }) {
  const complete = count >= WEEKLY_FACT_TARGET;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="status">
      <div aria-hidden className="flex gap-1">
        {Array.from({ length: WEEKLY_FACT_TARGET }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-1.5 w-5 rounded-full",
              index < count
                ? complete
                  ? "bg-success"
                  : "bg-foreground"
                : "bg-border",
            )}
          />
        ))}
      </div>
      <span
        className={cn(
          "text-xs",
          complete ? "text-success-foreground" : "text-muted-foreground",
        )}
      >
        {count} {count === 1 ? "fact" : "facts"} ·{" "}
        {complete
          ? "Seven facts give the initial drafts distinct starting points."
          : "One fact per line works well."}
      </span>
    </div>
  );
}

function FileFill({
  label,
  onLoad,
  onError,
}: {
  label: string;
  onLoad: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [loaded, setLoaded] = useState("");

  return (
    <span className="flex shrink-0 items-center gap-2">
      {loaded && (
        <span className="inline-flex max-w-40 items-center gap-1 text-xs text-success-foreground">
          <Icon name="Check" className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{loaded}</span>
        </span>
      )}
      <label className="relative inline-flex h-6 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring/60 pointer-coarse:h-9">
        <Icon name="FileText" className="size-3.5" aria-hidden />
        Load from file
        <input
          type="file"
          accept="text/plain,.md,.txt"
          aria-label={label + " text file"}
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];

            if (!file) return;

            if (
              file.size > 32768 ||
              !/\.(txt|md)$/i.test(file.name) ||
              (file.type !== "" &&
                !["text/plain", "text/markdown", "text/x-markdown"].includes(
                  file.type,
                ))
            ) {
              onError("Choose a text file no larger than 32 KiB.");

              return;
            }

            void file
              .arrayBuffer()
              .then((buffer) => {
                const value = new TextDecoder("utf-8", {
                  fatal: true,
                }).decode(buffer);

                onLoad(value);
                setLoaded(file.name);
              })
              .catch((reason: unknown) => onError(errorMessage(reason)));
          }}
        />
      </label>
    </span>
  );
}

function InputField({
  input,
  weekly,
  inputs,
  setInputs,
  onError,
}: {
  input: WorkflowInput;
  weekly: boolean;
  inputs: InputValues;
  setInputs: (update: (current: InputValues) => InputValues) => void;
  onError: (message: string) => void;
}) {
  const fieldId = `workflow-input-${input.id}`;
  const facts = weekly && input.id === "product-facts";
  const label = facts ? "Product facts from your notes" : input.label;
  const hint = weekly ? FIELD_HINTS[input.id] : undefined;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const short = SHORT_INPUTS.has(input.id);

  if (input.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-foreground"
          checked={inputs[input.id] === true}
          onChange={(event) => {
            const checked = event.target.checked;
            setInputs((current) => ({ ...current, [input.id]: checked }));
          }}
        />
        {label}
      </label>
    );
  }

  return (
    <div className="space-y-1.5">
      <div>
        <div className="flex min-h-6 items-center justify-between gap-3">
          <label
            htmlFor={fieldId}
            className="block min-w-0 text-sm font-medium"
          >
            {label}
          </label>
          {input.type === "text" && !short && (
            <FileFill
              label={label}
              onError={onError}
              onLoad={(value) =>
                setInputs((current) => ({ ...current, [input.id]: value }))
              }
            />
          )}
        </div>
        {hint && (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      {input.type === "text" ? (
        <Textarea
          id={fieldId}
          required={weekly && BRIEF_INPUTS.includes(input.id)}
          value={String(inputs[input.id] ?? "")}
          rows={facts ? 8 : short ? 1 : 3}
          aria-describedby={hintId}
          className={cn(
            short && "min-h-9 resize-none",
            facts && "font-mono text-sm leading-relaxed",
          )}
          placeholder={
            facts
              ? "Enter only facts you can verify about your product."
              : undefined
          }
          onChange={(event) => {
            const value = event.target.value;
            setInputs((current) => ({ ...current, [input.id]: value }));
          }}
        />
      ) : (
        <Input
          id={fieldId}
          required
          aria-describedby={hintId}
          type={input.type === "integer" ? "number" : "text"}
          min={input.id === "delivery-weekday" ? 1 : undefined}
          max={input.id === "delivery-weekday" ? 7 : undefined}
          value={String(inputs[input.id] ?? "")}
          onChange={(event) => {
            const value =
              input.type === "integer"
                ? event.target.valueAsNumber
                : event.target.value;

            setInputs((current) => ({ ...current, [input.id]: value }));
          }}
        />
      )}
      {facts && (
        <FactsProgress count={productFactLines(inputs[input.id]).length} />
      )}
    </div>
  );
}

function revealInvalid(event: FormEvent<HTMLFormElement>) {
  const target = event.target;

  if (
    !(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)
  )
    return;
  const details = target.closest("details");

  if (details && !details.open) {
    details.open = true;
    requestAnimationFrame(() => target.reportValidity());
  }
}

export function Disclosure({
  title,
  icon,
  summary,
  tag,
  defaultOpen,
  children,
}: {
  title: string;
  icon: string;
  summary?: string;
  tag?: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group rounded-lg border border-border bg-surface-raised"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-state-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/60 [&::-webkit-details-marker]:hidden">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-state-hover text-muted-foreground">
          <Icon name={icon} className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {title}
            {tag && (
              <span className="rounded-full bg-state-hover px-1.5 text-2xs font-medium text-muted-foreground">
                {tag}
              </span>
            )}
          </span>
          {summary && (
            <span className="block truncate text-xs text-muted-foreground">
              {summary}
            </span>
          )}
        </span>
        <Icon
          name="ChevronDown"
          className={cn(
            "size-4 shrink-0 text-muted-foreground group-open:rotate-180",
            DISCLOSURE_CHEVRON_TRANSITION,
          )}
          aria-hidden
        />
      </summary>
      <div className="space-y-4 border-t border-border-seam px-3 pb-3 pt-3">
        {children}
      </div>
    </details>
  );
}

export function DeviceModelFields({
  choices,
  models,
  host,
  model,
  onHostChange,
  onModelChange,
}: {
  choices: SetupOptions | undefined;
  models: SetupOptions["models"];
  host: string;
  model: string;
  onHostChange: (host: string) => void;
  onModelChange: (model: string) => void;
}) {
  return (
    <>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Omnyo sends your brief and supplied sources to the Codex or Claude Code
        model you select. Keep the selected device connected for scheduled runs.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Device</span>
          <NativeSelect required value={host} onChange={onHostChange}>
            <option value="">Choose device</option>
            {choices?.hosts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Model</span>
          <NativeSelect required value={model} onChange={onModelChange}>
            <option value="">
              {host ? "Choose model" : "Choose a device first"}
            </option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
    </>
  );
}

export function BriefForm({
  copy,
  choices,
  models,
  host,
  model,
  inputs,
  busy,
  canPreview = true,
  onHostChange,
  onModelChange,
  setInputs,
  onError,
  onSubmit,
  onCancel,
}: {
  copy: Copy;
  choices: SetupOptions | undefined;
  models: SetupOptions["models"];
  host: string;
  model: string;
  inputs: InputValues;
  busy: boolean;
  canPreview?: boolean;
  onHostChange: (host: string) => void;
  onModelChange: (model: string) => void;
  setInputs: (update: (current: InputValues) => InputValues) => void;
  onError: (message: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
}) {
  const weekly = isWeeklyFeed(copy);

  const primary = weekly
    ? copy.package.inputs.filter((input) => BRIEF_INPUTS.includes(input.id))
    : copy.package.inputs;

  const optional = weekly
    ? copy.package.inputs.filter((input) => !BRIEF_INPUTS.includes(input.id))
    : [];

  const hostName = choices?.hosts.find((item) => item.id === host)?.name;
  const modelName = models.find((item) => item.id === model)?.name;

  const optionalSummary = optional
    .filter((input) => input.type !== "text" || SHORT_INPUTS.has(input.id))
    .map((input) =>
      input.id === "delivery-weekday" &&
      typeof inputs[input.id] === "number" &&
      Number(inputs[input.id]) >= 1 &&
      Number(inputs[input.id]) <= 7
        ? `Starts ${weekdayName(Number(inputs[input.id]))}`
        : String(inputs[input.id] ?? ""),
    )
    .filter(Boolean)
    .join(" · ");

  return (
    <form
      onSubmit={onSubmit}
      onInvalidCapture={revealInvalid}
      className="space-y-5"
    >
      <div className="space-y-1">
        <h2 className="text-lead font-semibold">
          {weekly ? "Your startup brief" : "Make it yours"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {weekly
            ? "Describe your audience and enter the facts the writer can use."
            : "Fill in the inputs this workflow uses. Nothing runs until you preview and confirm."}
        </p>
      </div>
      <div className="space-y-4">
        {primary.map((input) => (
          <InputField
            key={input.id}
            input={input}
            weekly={weekly}
            inputs={inputs}
            setInputs={setInputs}
            onError={onError}
          />
        ))}
      </div>
      <div className="space-y-2">
        {optional.length > 0 && (
          <Disclosure
            title="References, style and delivery"
            icon="SlidersHorizontal"
            tag="Optional"
            summary={optionalSummary || `${optional.length} optional settings`}
            defaultOpen={false}
          >
            {optional.map((input) => (
              <InputField
                key={input.id}
                input={input}
                weekly={weekly}
                inputs={inputs}
                setInputs={setInputs}
                onError={onError}
              />
            ))}
          </Disclosure>
        )}
        {!weekly && (
          <Disclosure
            title="Device and model"
            icon="Bot"
            summary={
              hostName && modelName
                ? `${hostName} · ${modelName}`
                : "Choose where drafts are written"
            }
            defaultOpen={!host || !model}
          >
            <DeviceModelFields
              choices={choices}
              models={models}
              host={host}
              model={model}
              onHostChange={onHostChange}
              onModelChange={onModelChange}
            />
          </Disclosure>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border-seam pt-4">
        <Button disabled={busy || !canPreview} type="submit">
          {busy && <Icon name="Spinner" className="animate-spin" aria-hidden />}
          {weekly ? "Preview week" : "Save and preview"}
          {!busy && <Icon name="ArrowRight" aria-hidden />}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function BriefSummary({
  copy,
  choices,
  models,
  onEdit,
}: {
  copy: Copy;
  choices: SetupOptions | undefined;
  models: SetupOptions["models"];
  onEdit: () => void;
}) {
  const bindings = copy.bindings;

  if (!bindings) return null;
  const weekly = isWeeklyFeed(copy);

  const hostName =
    choices?.hosts.find((item) => item.id === bindings.hostId)?.name ??
    bindings.hostId;

  const modelName =
    models.find(
      (item) =>
        item.model === bindings.model &&
        item.providerId === bindings.providerId,
    )?.name ?? bindings.model;

  const rows = weekly
    ? [
        ["Audience", String(bindings.inputs.audience ?? "")],
        [
          "Product facts",
          `${productFactLines(bindings.inputs["product-facts"]).length} supplied`,
        ],
      ]
    : copy.package.inputs.map((input) => [
        input.label,
        String(bindings.inputs[input.id] ?? ""),
      ]);

  return (
    <Panel label="Saved brief">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-success-foreground">
            <Icon name="CircleCheck" className="size-3.5" aria-hidden />
            Brief saved
          </p>
          <h2 className="truncate text-lead font-semibold">
            {weekly
              ? String(bindings.inputs.startup ?? copy.package.title)
              : copy.package.title}
          </h2>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Icon name="Edit" aria-hidden />
          Edit brief
        </Button>
      </div>
      <dl className="mt-4 grid gap-px overflow-hidden rounded-lg border border-border-seam bg-border-seam text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="bg-surface-recessed px-3 py-2 text-muted-foreground">
              {label}
            </dt>
            <dd className="min-w-0 truncate bg-card px-3 py-2">
              {value || "—"}
            </dd>
          </div>
        ))}
        <dt className="bg-surface-recessed px-3 py-2 text-muted-foreground">
          Runs on
        </dt>
        <dd className="min-w-0 truncate bg-card px-3 py-2">
          {hostName} · {modelName}
        </dd>
      </dl>
    </Panel>
  );
}

export function WeekPreview({
  title,
  inputs,
  keywords,
  animate = false,
}: {
  title: string;
  inputs: InputValues;
  keywords?: readonly { keyword: string }[];
  animate?: boolean;
}) {
  const facts = productFactLines(inputs["product-facts"]);
  const keywordsByTopic = new Map<string, string>();

  for (const { keyword } of keywords ?? []) {
    const topic = keyword.normalize("NFKC").toLowerCase();

    if (!keywordsByTopic.has(topic)) keywordsByTopic.set(topic, keyword);
  }

  const focus = keywords
    ? [...keywordsByTopic.values()]
    : facts.length >= WEEKLY_FACT_TARGET
      ? facts
      : [];

  const firstDay = Number(inputs["delivery-weekday"] ?? 1);
  const start = firstDay >= 1 && firstDay <= 7 ? firstDay : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-state-hover text-muted-foreground">
          <Icon name="Calendar" className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            {String(inputs.startup ?? title)} · your first week
          </h3>
          <p className="text-sm text-muted-foreground">
            Seven drafts, each written and independently reviewed before
            delivery. The calendar starts on the next{" "}
            {weekdayName(start, "long")} after a run
            {inputs.timezone ? ` (${String(inputs.timezone)})` : ""}.
          </p>
        </div>
      </div>
      {(keywords || focus.length === 0) && (
        <div className="space-y-1.5">
          <div>
            <h4 className="text-sm font-medium">Product facts</h4>
            <p className="text-xs text-muted-foreground">
              {keywords
                ? "The writer uses these facts to support drafts focused on your selected keywords."
                : "The writer selects a focus from these notes."}
            </p>
          </div>
          <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-recessed px-3 py-2.5 text-sm">
            {String(inputs["product-facts"] ?? "")}
          </p>
        </div>
      )}
      <ol className="divide-y divide-border-seam overflow-hidden rounded-lg border border-border bg-surface-recessed">
        {Array.from({ length: WEEKLY_FACT_TARGET }, (_, index) => {
          const topic = focus[index];

          const stagger = getStaggerItemProps(
            index,
            WEEKLY_FACT_TARGET,
            animate,
          );

          return (
            <li
              key={index}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5",
                stagger.className,
              )}
              style={stagger.style}
            >
              <span
                className={cn(
                  "flex w-12 shrink-0 flex-col items-center rounded-md border py-1 leading-none",
                  topic
                    ? "border-border bg-card"
                    : "border-dashed border-border",
                )}
              >
                <span className="text-xs font-semibold uppercase">
                  {weekdayName(start + index)}
                </span>
                <span className="mt-1 text-2xs text-muted-foreground">
                  Day {index + 1}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                {topic ? (
                  <>
                    <span className="block text-xs text-muted-foreground">
                      Initial candidate {index + 1} focus
                    </span>
                    <span className="block break-words text-sm">{topic}</span>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Topic chosen at generation
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const CAPABILITIES: Record<
  Review["capabilities"][number],
  { title: string; detail: string; icon: string; warning: boolean }
> = {
  "model-text": {
    title: "Sends your brief to a model you choose",
    detail:
      "Your brief and the instructions below go to the Codex or Claude Code model you pick, on one of your connected devices.",
    icon: "Bot",
    warning: false,
  },
  "write-run-artifacts": {
    title: "Saves its text with each run",
    detail:
      "The text it writes stays in this workflow’s run history. It does not publish anything.",
    icon: "FileText",
    warning: false,
  },
  "replace-script-requirement": {
    title: "Needs a script replaced before it can run",
    detail:
      "It was shared with a local script, which Omnyo does not run. Replace it with a supported action first.",
    icon: "AlertTriangle",
    warning: true,
  },
};

function CodeDetails({ title, children }: { title: string; children: string }) {
  const words = children.split(/\s+/).filter(Boolean).length;

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5 text-sm outline-none hover:bg-state-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring/60 [&::-webkit-details-marker]:hidden">
        <Icon
          name="FileText"
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {words === 1 ? "1 word" : `${words} words`}
        </span>
        <Icon
          name="ChevronDown"
          className={cn(
            "size-4 shrink-0 text-muted-foreground group-open:rotate-180",
            DISCLOSURE_CHEVRON_TRANSITION,
          )}
          aria-hidden
        />
      </summary>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border-seam bg-surface-recessed px-3 py-2.5 font-mono text-xs leading-relaxed text-muted-foreground">
        {children}
      </pre>
    </details>
  );
}

function ReviewChip({
  icon,
  children,
  tone = "neutral",
}: {
  icon: string;
  children: ReactNode;
  tone?: "neutral" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs",
        tone === "warning"
          ? "bg-warning/15 text-warning-text"
          : "bg-state-hover text-muted-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      {children}
    </span>
  );
}

function ReviewSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function PackageReview({ review }: { review: Review }) {
  const { flow, skills } = review.package;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-surface-raised shadow-control">
          <Icon name="Workflow" className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 space-y-2">
          <div className="space-y-0.5">
            <h2 className="text-lead font-semibold">{review.package.title}</h2>
            <p className="text-sm text-muted-foreground">
              {review.package.description}
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <ReviewChip
              icon={
                review.source === "link"
                  ? "Link"
                  : review.source === "template"
                    ? "Sparkles"
                    : "File"
              }
            >
              {review.source === "link"
                ? "Shared link"
                : review.source === "template"
                  ? "Built-in template"
                  : "File or paste"}
            </ReviewChip>
            <ReviewChip icon="GitCommit">
              Revision {review.package.revision}
            </ReviewChip>
            {review.package.senderLabel && (
              <ReviewChip icon="UserRound" tone="warning">
                From {review.package.senderLabel} (not verified)
              </ReviewChip>
            )}
          </div>
        </div>
      </div>
      <ReviewSection
        title="What it can do"
        description="The complete list of what this workflow is allowed to do."
      >
        <ul className="divide-y divide-border-seam overflow-hidden rounded-lg border border-border">
          {review.capabilities.map((item) => {
            const capability = CAPABILITIES[item];

            return (
              <li key={item} className="flex items-start gap-3 px-3 py-2.5">
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-md",
                    capability.warning
                      ? "bg-warning/15 text-warning-text"
                      : "bg-state-hover text-muted-foreground",
                  )}
                >
                  <Icon name={capability.icon} className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {capability.title}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {capability.detail}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </ReviewSection>
      <ReviewSection
        title="What it tells the model"
        description="The exact instructions it runs with. Open one to read it."
      >
        <div className="divide-y divide-border-seam overflow-hidden rounded-lg border border-border">
          {flow.kind === "prompt" && (
            <CodeDetails title="Prompt">{flow.prompt}</CodeDetails>
          )}
          {flow.kind === "graph" &&
            flow.engine === "restricted" &&
            flow.steps.map((step) => (
              <CodeDetails key={step.id} title={step.id}>
                {step.kind === "model"
                  ? step.prompt
                  : step.kind === "export"
                    ? "Export text"
                    : step.kind === "validate-text"
                      ? `Validate text up to ${step.maxBytes} bytes`
                      : `If the preceding text ${step.operand === "equals" ? "equals" : "contains"} ${JSON.stringify(step.value)}`}
              </CodeDetails>
            ))}
          {flow.kind === "graph" && flow.engine === "weekly-content-feed" && (
            <>
              <CodeDetails title="Writer prompt">
                {flow.writer.prompt}
              </CodeDetails>
              <CodeDetails title="Reviewer prompt">
                {flow.reviewer.prompt}
              </CodeDetails>
            </>
          )}
          {skills.map((skill) => (
            <CodeDetails key={skill.id} title={skill.title}>
              {skill.body}
            </CodeDetails>
          ))}
        </div>
      </ReviewSection>
      <p className="flex items-start gap-1.5 text-2xs text-muted-foreground">
        <Icon
          name="ShieldCheck"
          className="mt-px size-3.5 shrink-0"
          aria-hidden
        />
        <span className="min-w-0 break-all">
          Fingerprint (SHA-256){" "}
          <span className="font-mono">{review.packageDigest}</span>
        </span>
      </p>
    </div>
  );
}
