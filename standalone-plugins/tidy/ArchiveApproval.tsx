import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  experimental_useAppNavigate,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginPendingInteractionProps,
} from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import {
  approvalPayloadSchema,
  chatCount,
  chatIdSchema,
  legacyProposalText,
  MAX_APPROVAL_CHATS,
  type ArchiveResult,
} from "./archive-approval";
import type { ArchiveReview, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type Chat = ArchiveReview["chats"][number];

type ReviewError = "load" | "uncertain";

const ACTION_CLASS = "w-full @min-[24rem]:w-auto pointer-coarse:h-11";

function ChatList({ chats }: { chats: Chat[] }) {
  const navigate = experimental_useAppNavigate();

  return (
    <ul className="m-0 max-h-56 list-none overflow-y-auto p-0">
      {chats.map((chat) => (
        <li
          key={chat.threadId}
          className="m-0 flex items-start gap-2 py-1.5 pointer-coarse:min-h-11"
        >
          <Icon
            name={
              chat.state === "ready"
                ? "Circle"
                : chat.state === "archived"
                  ? "Check"
                  : "AlertCircle"
            }
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <div className="min-w-0">
            {chat.state === "unavailable" ? (
              <span className="break-words">{chat.title}</span>
            ) : (
              <button
                type="button"
                className="block max-w-full break-words text-left hover:underline focus-visible:underline"
                onClick={() => navigate.toThread(chat.threadId)}
              >
                {chat.title}
              </button>
            )}
            {chat.detail === null ? null : (
              <span className="block break-words text-xs text-muted-foreground">{chat.detail}</span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function Status({
  icon,
  role,
  children,
}: {
  icon: "AlertCircle" | "Spinner";
  role: "alert" | "status";
  children: ReactNode;
}) {
  return (
    <div role={role} className="flex min-w-0 items-center gap-2 text-muted-foreground">
      <Icon name={icon} className="size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 @min-[24rem]:flex-row @min-[24rem]:justify-end">
      {children}
    </div>
  );
}

function ArchiveApproval({
  sourceThreadId,
  selection,
  submit,
  cancel,
}: {
  sourceThreadId: string;
  selection: string;
  submit: PluginPendingInteractionProps["submit"];
  cancel: PluginPendingInteractionProps["cancel"];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [review, setReview] = useState<ArchiveReview | null>(null);
  const [error, setError] = useState<ReviewError | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ArchiveResult>({ archived: 0, failures: [] });
  const submitting = useRef(false);

  useEffect(() => {
    let current = true;

    void rpc.call("archive_review", { sourceThreadId, threadIds: selection.split("|") }).then(
      (next) => {
        if (current) setReview(next);
      },
      () => {
        if (current) setError("load");
      },
    );

    return () => {
      current = false;
    };
  }, [rpc, sourceThreadId, selection, version]);

  const chats = review?.chats ?? [];

  const reviewed = chats.flatMap(({ threadId, title, basis }) =>
    basis === null ? [] : [{ threadId, title, basis }],
  );

  const ready = chats.filter(({ state }) => state === "ready");
  const archived = chats.filter(({ state }) => state === "archived");
  const failed = chats.filter(({ state }) => state === "failed");
  const others = chats.filter(({ state }) => state !== "ready" && state !== "archived");

  async function approve() {
    if (submitting.current || reviewed.length === 0) return;
    submitting.current = true;
    setBusy(true);

    try {
      const outcome = await rpc.call("archive_approval", { sourceThreadId, reviewed });

      const total = {
        archived: result.archived + outcome.archived,
        failures: outcome.failures,
      };

      setResult(total);

      if (outcome.failures.length === 0) {
        await submit(total);

        return;
      }

      const failures = new Map(
        outcome.failures.map(({ threadId, message }) => [threadId, message]),
      );

      const selected = new Set(reviewed.map(({ threadId }) => threadId));

      setReview((previous) =>
        previous === null
          ? null
          : {
              chats: previous.chats.map((chat) => {
                if (!selected.has(chat.threadId)) return chat;
                const detail = failures.get(chat.threadId) ?? null;

                return {
                  ...chat,
                  basis: null,
                  state: detail === null ? "archived" : "failed",
                  detail,
                };
              }),
            },
      );
    } catch {
      setReview(null);
      setError("uncertain");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function refresh() {
    setReview(null);
    setError(null);
    setVersion((value) => value + 1);
  }

  const notNow = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={ACTION_CLASS}
      disabled={busy}
      onClick={() => void cancel()}
    >
      Not now
    </Button>
  );

  if (error !== null)
    return (
      <div className="@container flex flex-col gap-3 text-sm text-foreground">
        <Status icon="AlertCircle" role="alert">
          {error === "load" ? "Couldn’t load these chats." : "Couldn’t confirm the archive."}
        </Status>
        <Actions>
          {notNow}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={ACTION_CLASS}
            onClick={refresh}
          >
            {error === "load" ? "Try again" : "Review again"}
          </Button>
        </Actions>
      </div>
    );

  if (review === null)
    return (
      <div className="@container text-sm">
        <Status icon="Spinner" role="status">
          Checking chats…
        </Status>
      </div>
    );

  const settled = ready.length === 0;

  const summary =
    failed.length > 0
      ? `Couldn’t archive ${chatCount(failed.length)}.`
      : settled
        ? archived.length === chats.length
          ? "These chats are already archived."
          : "None of these chats is ready to archive now."
        : others.length > 0
          ? `${ready.length} of ${chats.length} are still ready.`
          : null;

  return (
    <div aria-busy={busy} className="@container flex flex-col gap-3 text-sm text-foreground">
      {summary === null ? null : (
        <p role="status" className="m-0 text-muted-foreground">
          {summary}
        </p>
      )}
      {ready.length > 0 ? <ChatList chats={ready} /> : null}
      {others.length > 0 ? <ChatList chats={others} /> : null}
      {archived.length > 0 && !settled ? (
        <p className="m-0 text-xs text-muted-foreground">
          {chatCount(archived.length)} already archived
        </p>
      ) : archived.length > 0 ? (
        <ChatList chats={archived} />
      ) : null}
      <Actions>
        {settled ? (
          <>
            {failed.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className={ACTION_CLASS}
                onClick={refresh}
              >
                Review again
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              className={ACTION_CLASS}
              onClick={() =>
                void (result.archived > 0 || failed.length > 0 || archived.length === chats.length
                  ? submit(result)
                  : cancel())
              }
            >
              Done
            </Button>
          </>
        ) : (
          <>
            {notNow}
            <Button
              type="button"
              size="sm"
              className={ACTION_CLASS}
              disabled={busy}
              onClick={() => void approve()}
            >
              {busy ? (
                <>
                  <Icon name="Spinner" aria-hidden />
                  Archiving…
                </>
              ) : (
                `Archive ${chatCount(reviewed.length)}`
              )}
            </Button>
          </>
        )}
      </Actions>
    </div>
  );
}

export function ArchiveApprovalForm({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const payload = approvalPayloadSchema.safeParse(interaction.payload);

  if (!payload.success)
    return (
      <div className="@container flex flex-col gap-3 text-sm text-foreground">
        <Status icon="AlertCircle" role="alert">
          This archive approval can’t be read.
        </Status>
        <Actions>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={ACTION_CLASS}
            onClick={() => void cancel()}
          >
            Dismiss
          </Button>
        </Actions>
      </div>
    );

  return (
    <ArchiveApproval
      key={interaction.id}
      sourceThreadId={interaction.threadId}
      selection={payload.data.threadIds.join("|")}
      submit={submit}
      cancel={cancel}
    />
  );
}

const legacySelectionSchema = z
  .string()
  .transform((value) => [...new Set(value.split("|"))])
  .pipe(z.array(chatIdSchema).min(1).max(MAX_APPROVAL_CHATS));

export function ArchiveProposalReceipt({ attributes, source }: PluginMessageDirectiveProps) {
  const selection = legacySelectionSchema.safeParse(attributes.chats);

  if (!selection.success) return source;

  return (
    <span className="my-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <Icon name="Archive" className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{legacyProposalText(selection.data.length)}</span>
    </span>
  );
}
