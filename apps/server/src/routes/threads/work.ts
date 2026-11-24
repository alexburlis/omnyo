import { publishThreadWork } from "@omnyo/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@omnyo/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";
import { buildThreadListEntry } from "../../services/threads/thread-runtime-display.js";
import { archiveThreadAndChildren } from "../../services/threads/thread-archive.js";
import { archiveRootViaInbox } from "../../services/inbox/actions.js";
import {
  getInboxThread,
  isInboxDomainRoot,
} from "../../services/inbox/family.js";

export function registerThreadWorkRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  const routes = publicApiRoutes.threads;

  const read = (threadId: string) => {
    requirePublicThread(deps.db, threadId);
    const work = buildThreadListEntry(deps, threadId)?.work;

    if (work === null || work === undefined)
      throw new ApiError(
        503,
        "invalid_request",
        "Chat work evidence is unavailable",
      );

    return work;
  };

  get(routes.work, (context) => context.json(read(context.req.param("id"))));
  post(routes.publishWork, (context, input) => {
    const threadId = context.req.param("id");

    const changed = deps.db.transaction(
      () => {
        const current = read(threadId);

        if (
          input.contribution.kind === "assessment" &&
          input.contribution.assessment.basis !== current.basis
        )
          throw new ApiError(
            409,
            "invalid_request",
            "Chat work changed before the assessment finished",
          );
        const published = publishThreadWork(deps.db, threadId, input);

        return published;
      },
      { behavior: "immediate" },
    );

    if (changed) deps.hub.notifyThread(threadId, ["work-changed"]);

    return context.json(read(threadId));
  });
  post(routes.archiveReady, (context, input) => {
    const threadId = context.req.param("id");

    const thread = requirePublicThread(deps.db, threadId);

    if (thread.archivedAt !== null)
      return context.json({ ok: true, archivedThreadIds: [threadId] });

    const work = read(threadId);

    if (work.basis !== input.basis || !work.archive.recommended)
      throw new ApiError(
        409,
        "invalid_request",
        "This chat is no longer ready to archive",
      );

    const root = getInboxThread(deps.db, threadId);

    const archivedThreadIds =
      root !== null && isInboxDomainRoot(root)
        ? archiveRootViaInbox(deps, {
            rootId: threadId,
            displayed: "all",
            stopRunning: false,
            now: Date.now(),
          }).archivedThreadIds
        : archiveThreadAndChildren(deps, {
            parentThread: thread,
            stopRunning: false,
          });

    return context.json({ ok: true, archivedThreadIds });
  });
}
