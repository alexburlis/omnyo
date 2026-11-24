import {
  environmentHasLiveThreads,
  environments,
  findEnvironmentPathClaim,
  getHost,
  getPreparingEnvironment,
  getThread,
  type EnvironmentRow,
} from "@omnyo/db";
import { canonicalizeHostPath } from "@omnyo/domain";
import { eq } from "drizzle-orm";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

export const CHECKOUT_BUSY_MESSAGE =
  "Cannot checkout branch while another thread is using this workspace";

export function findBlockingEnvironmentPathClaim(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: { hostId: string; path: string; owner: EnvironmentRow | null },
): EnvironmentRow | null {
  if (
    findEnvironmentPathClaim(deps.db, args.hostId, args.path, args.owner) ===
    null
  )
    return null;

  return deps.db.transaction(
    () => {
      let claim = findEnvironmentPathClaim(
        deps.db,
        args.hostId,
        args.path,
        args.owner,
      );

      while (claim !== null) {
        if (claim.ownerThreadId === null || claim.teardownStatus !== null)
          return claim;
        const owner = getThread(deps.db, claim.ownerThreadId);

        if (owner?.status === "starting" || owner?.status === "stopping")
          return claim;

        if (getHost(deps.db, claim.hostId)?.phase === "removing") return claim;

        const reusable =
          (claim.status === "ready" && claim.path !== null) ||
          environmentHasLiveThreads(deps.db, claim.id);

        const updated = deps.db
          .update(environments)
          .set(
            reusable
              ? {
                  updatedAt: Date.now(),
                  ownerThreadId: null,
                  claimPath: null,
                  statusMessage: null,
                  retireAt: null,
                }
              : {
                  updatedAt: Date.now(),
                  teardownStatus: "running",
                  retireAt: Date.now(),
                },
          )
          .where(eq(environments.id, claim.id))
          .run();

        if (updated.changes === 0) return claim;
        deps.hub.notifyEnvironment(claim.id, ["metadata-changed"]);

        if (!reusable) return { ...claim, teardownStatus: "running" };
        claim = findEnvironmentPathClaim(
          deps.db,
          args.hostId,
          args.path,
          args.owner,
        );
      }

      return null;
    },
    { behavior: "immediate" },
  );
}

export function assertEnvironmentPathAvailable(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: { hostId: string; path: string | null; threadId: string | null },
): void {
  if (args.path === null) return;
  const path = canonicalizeHostPath(args.path);

  const owner =
    args.threadId === null
      ? null
      : getPreparingEnvironment(deps.db, args.threadId);

  const claim = findBlockingEnvironmentPathClaim(deps, {
    hostId: args.hostId,
    path,
    owner,
  });

  if (claim !== null) throwWorkspaceBusy(claim);
}

export function assertThreadEnvironmentPathAvailable(
  deps: Pick<WorkSessionDeps, "db" | "hub">,
  args: { environment: EnvironmentRow; threadId: string },
): void {
  const { environment } = args;

  if (environment.path === null) return;

  const claim = findBlockingEnvironmentPathClaim(deps, {
    hostId: environment.hostId,
    path: canonicalizeHostPath(environment.path),
    owner: getPreparingEnvironment(deps.db, args.threadId),
  });

  if (claim === null) return;

  const attachingSibling =
    environment.status === "ready" &&
    claim.teardownStatus === null &&
    claim.ownerThreadId !== null &&
    getThread(deps.db, args.threadId)?.archivedAt === null;

  if (!attachingSibling) throwWorkspaceBusy(claim);
}

function throwWorkspaceBusy(claim: EnvironmentRow): never {
  throw new ApiError(
    409,
    "workspace_busy",
    claim.teardownStatus === null
      ? CHECKOUT_BUSY_MESSAGE
      : "Workspace cleanup is pending. Try again shortly.",
  );
}
