import {
  PendingInteractionShell,
  type PendingInteractionSourceThread,
} from "@/components/thread/pending-interactions/PendingInteractionShell";
import { Activity, useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import type { JsonValue, PendingInteraction } from "@omnyo/domain";
import { PluginSlotMount } from "./PluginSlotMount";
import { Skeleton } from "@omnyo/shared-ui/skeleton";
import { resolvePendingInteraction } from "@/lib/plugin-slot-resolvers";
import { usePluginDisplayName } from "@/lib/plugin-logos";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { sdk } from "@/lib/sdk";

export interface PluginPendingInteractionRequest {
  pluginId: string;
  rendererId: string;
  title: string;
  data: JsonValue;
}

interface PluginPendingInteractionComposerProps {
  interaction: Pick<
    PendingInteraction,
    "id" | "threadId" | "createdAt" | "expiresAt"
  >;
  request: PluginPendingInteractionRequest;
  origin: "plugin" | "provider";
  sourceThread?: PendingInteractionSourceThread;
  collapsedByDefault: boolean;
}

export function PluginPendingInteractionComposer({
  interaction,
  request,
  origin,
  sourceThread,
  collapsedByDefault,
}: PluginPendingInteractionComposerProps) {
  const { pendingInteractions } = usePluginSlots();
  const pluginName = usePluginDisplayName(request.pluginId);
  const pluginsSettled = usePluginFrontendsSettled();
  const stopThread = useStopThread();
  const [localError, setError] = useState<string | null>(null);
  const [localSubmitting, setSubmitting] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);

  const mutationKey = [
    "plugin-interaction-response",
    interaction.threadId,
    interaction.id,
  ];

  const response = useMutation({
    mutationKey,
    meta: { showErrorToast: false },
    mutationFn: (value: JsonValue) =>
      sdk.threads.interactions
        .respond({
          interactionId: interaction.id,
          threadId: interaction.threadId,
          value,
        })
        .then(() => {}),
  });

  const { mutateAsync: respond } = response;

  const submissions = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      status: entry.state.status,
      error: entry.state.error,
    }),
  });

  const latestSubmission = submissions.at(-1) ?? response;

  const submitting =
    localSubmitting ||
    latestSubmission.status === "pending" ||
    latestSubmission.status === "success";

  const responseError = latestSubmission.error;

  const error =
    localError ??
    (submitting || !responseError
      ? null
      : responseError instanceof Error
        ? responseError.message
        : String(responseError));

  const questionSubmitting =
    request.pluginId === "ask-user-question" && submitting;

  const slot = useMemo(
    () =>
      resolvePendingInteraction(
        pendingInteractions,
        request.pluginId,
        request.rendererId,
      ),
    [request.pluginId, request.rendererId, pendingInteractions],
  );

  const submit = useCallback(
    (value: JsonValue) => {
      if (inFlight.current) return inFlight.current;
      flushSync(() => {
        setSubmitting(true);
        setError(null);
      });

      const task = respond(value).catch((cause: unknown) => {
        setSubmitting(false);
        throw cause;
      });

      inFlight.current = task;

      return task.finally(() => {
        if (inFlight.current === task) inFlight.current = null;
      });
    },
    [respond],
  );

  const cancel = useCallback(async () => {
    setSubmitting(true);
    setError(null);

    try {
      if (origin === "provider") {
        await stopThread.mutateAsync(interaction.threadId);
      } else {
        await sdk.threads.interactions.cancel({
          interactionId: interaction.id,
          threadId: interaction.threadId,
        });
      }
    } catch (cause) {
      setSubmitting(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [origin, interaction.id, interaction.threadId, stopThread]);

  const dismissLabel = origin === "plugin" ? "Cancel" : "Stop turn";

  return (
    <PendingInteractionShell
      key={interaction.id}
      label={request.title}
      expandedByDefault={!collapsedByDefault}
      errorMessage={error}
      sourceThread={sourceThread}
      testId="plugin-interaction-shell"
    >
      {() => (
        <>
          <p className="mb-4 text-xs text-muted-foreground">
            {origin === "plugin"
              ? `Requested by ${pluginName}`
              : `Asked by the agent through ${pluginName}`}
          </p>
          {slot ? (
            <PluginSlotMount
              pluginId={slot.pluginId}
              slotKind="pendingInteraction"
              slotId={slot.id}
              crashFallback={
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    The plugin form crashed. {dismissLabel} to continue.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void cancel()}
                    disabled={submitting}
                  >
                    {dismissLabel}
                  </Button>
                </div>
              }
            >
              {questionSubmitting ? (
                <div
                  role="status"
                  className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
                >
                  <Icon name="Spinner" className="size-3 animate-spin" />
                  Sending answer…
                </div>
              ) : null}
              <Activity mode={questionSubmitting ? "hidden" : "visible"}>
                <fieldset disabled={submitting} hidden={questionSubmitting}>
                  <slot.component
                    interaction={{
                      id: interaction.id,
                      threadId: interaction.threadId,
                      title: request.title,
                      payload: request.data,
                      createdAt: interaction.createdAt,
                      expiresAt: interaction.expiresAt ?? null,
                    }}
                    submit={submit}
                    cancel={cancel}
                  />
                </fieldset>
              </Activity>
            </PluginSlotMount>
          ) : pluginsSettled ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                The plugin form is unavailable. {dismissLabel} to continue.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void cancel()}
                disabled={submitting}
              >
                {dismissLabel}
              </Button>
            </div>
          ) : (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label={`Loading the ${pluginName} form`}
              data-testid="plugin-interaction-loading"
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-9 w-full" />
            </div>
          )}
        </>
      )}
    </PendingInteractionShell>
  );
}
