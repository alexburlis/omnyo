import { useId, useMemo, useState, type FormEvent } from "react";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
} from "@omnyo/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { QuestionForm } from "@/components/ui/question-form";
import { Textarea } from "@/components/ui/textarea";
import {
  PI_EXTENSION_UI_RENDERER_ID,
  piExtensionUiPayloadDataSchema,
  type PiExtensionUiPayloadData,
} from "./src/extension-ui-contract.js";

function parseRequest(payload: unknown): PiExtensionUiPayloadData | null {
  if (typeof payload !== "object" || payload === null) return null;
  const direct = piExtensionUiPayloadDataSchema.safeParse(payload);

  if (direct.success) return direct.data;
  const data = (payload as { data?: unknown }).data;
  const wrapped = piExtensionUiPayloadDataSchema.safeParse(data);

  return wrapped.success ? wrapped.data : null;
}

function ExtensionUiInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const request = useMemo(
    () => parseRequest(interaction.payload),
    [interaction.payload],
  );

  const [text, setText] = useState(request?.prefill ?? "");
  const [busy, setBusy] = useState(false);
  const messageId = useId();

  if (!request) {
    return (
      <div className="space-y-3 text-xs text-muted-foreground">
        <p className="flex items-start gap-2 rounded-lg bg-state-hover px-3 py-2 leading-5">
          <Icon
            name="AlertCircle"
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          This request could not be displayed.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void cancel()}
        >
          Cancel
        </Button>
      </div>
    );
  }

  const send = async (value: unknown) => {
    setBusy(true);

    try {
      await submit(value as never);
    } catch (cause) {
      setBusy(false);
      throw cause;
    }
  };

  const dismiss = async () => {
    setBusy(true);

    try {
      await cancel();
    } catch {
      setBusy(false);
    }
  };

  const finish = (value: unknown) => {
    if (busy) return;
    void send(value).catch(() => {});
  };

  if (request.method === "select") {
    const options = request.options ?? [];

    return (
      <QuestionForm
        key={interaction.id}
        questions={[
          {
            id: request.requestId,
            prompt: request.message ?? "",
            shortLabel: "Select",
            multiSelect: false,
            allowFreeText: false,
            options: options.map((label, index) => ({
              value: `option-${index}`,
              label,
            })),
          },
        ]}
        disabled={busy}
        cancelDisabled={busy}
        onCancel={cancel}
        onSubmit={async (answers) => {
          const selected = answers[request.requestId]?.selected[0];

          const index = selected?.startsWith("option-")
            ? Number(selected.slice("option-".length))
            : Number.NaN;

          const option = options[index];

          if (option === undefined)
            throw new Error(`Unknown option: ${selected}`);
          await send(option);
        }}
      />
    );
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();

    if (request.method === "confirm") return;
    finish(text);
  };

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 text-xs text-muted-foreground"
    >
      {request.message ? (
        <p
          id={messageId}
          className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
        >
          {request.message}
        </p>
      ) : null}
      {request.method === "input" ? (
        <Input
          type="text"
          value={text}
          placeholder={request.placeholder}
          aria-labelledby={request.message ? messageId : undefined}
          aria-label={request.message ? undefined : "Answer"}
          autoFocus
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      {request.method === "editor" ? (
        <Textarea
          className="min-h-32 resize-y font-mono"
          value={text}
          aria-labelledby={request.message ? messageId : undefined}
          aria-label={request.message ? undefined : "Text"}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      {request.method === "confirm" ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => finish(false)}
          >
            No
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => finish(true)}
          >
            Yes
          </Button>
        </div>
      ) : null}
      {request.method !== "confirm" ? (
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void dismiss()}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            Submit
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: PI_EXTENSION_UI_RENDERER_ID,
    component: ExtensionUiInteraction,
  });
});
