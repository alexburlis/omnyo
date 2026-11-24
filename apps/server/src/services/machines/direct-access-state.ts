import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getLatestSessionForHost, serverAccessRetirements } from "@omnyo/db";
import type { HostDirectAccessCoordinatorStatus } from "@omnyo/server-contract";
import type { WorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

type Deps = Pick<WorkSessionDeps, "db">;

type Proof = {
  kind: "handoff" | "current-primary";
  hostId: string;
  challenge: string;
  serverUrl: string;
  expectedSessionId: string;
  expiresAt: number;
  http: boolean;
  ws: boolean;
  primary: boolean;
  committed: boolean;
  releaseUncertain: boolean;
  resolvePrimary: () => void;
  primaryReady: Promise<void>;
};

type State = {
  instanceId: string;
  holds: Map<string, string>;
  proofs: Map<string, Proof>;
  lanes: Map<string, Promise<void>>;
};

const states = new WeakMap<Deps["db"], State>();

export function directAccessState(deps: Deps): State {
  let state = states.get(deps.db);

  if (!state) {
    state = {
      instanceId: randomUUID(),
      holds: new Map(),
      proofs: new Map(),
      lanes: new Map(),
    };
    states.set(deps.db, state);
  }

  return state;
}

export function getDirectRetirement(deps: Deps, hostId: string) {
  return (
    deps.db
      .select()
      .from(serverAccessRetirements)
      .where(eq(serverAccessRetirements.hostId, hostId))
      .get() ?? null
  );
}

export function isDirectAccessHeld(deps: Deps, hostId: string): boolean {
  const state = directAccessState(deps);

  if (state.holds.has(hostId)) return true;
  const row = getDirectRetirement(deps, hostId);

  return row !== null && row.primaryProofRuntimeId !== state.instanceId;
}

export function directAccessCoordinatorStatus(
  deps: Deps,
  hostId: string,
): HostDirectAccessCoordinatorStatus {
  const state = directAccessState(deps);
  const owner = state.holds.get(hostId);
  const row = getDirectRetirement(deps, hostId);

  const challenge =
    owner === "reserving" ? null : (owner ?? row?.challenge ?? null);

  const proof = challenge === null ? undefined : state.proofs.get(challenge);

  return {
    held: isDirectAccessHeld(deps, hostId),
    phase:
      owner === "reserving"
        ? "reserving"
        : proof?.releaseUncertain
          ? "release-uncertain"
          : row !== null
            ? row.primaryProofRuntimeId === state.instanceId
              ? "retirement-pending"
              : "awaiting-primary"
            : owner !== undefined
              ? "probing"
              : "idle",
    instanceId: state.instanceId,
    sessionId:
      proof?.expectedSessionId ??
      getLatestSessionForHost(deps.db, { hostId })?.id ??
      null,
    ownerFingerprint:
      challenge === null
        ? null
        : createHash("sha256").update(challenge).digest("hex"),
  };
}

export function assertDirectAccessAdmission(deps: Deps, hostId: string): void {
  if (isDirectAccessHeld(deps, hostId))
    throw new ApiError(
      409,
      "direct_access_held",
      "Machine admission is held for a direct access handoff",
    );
}

export function withServerAccessLane<T>(
  deps: Deps,
  hostId: string,
  work: () => Promise<T>,
): Promise<T> {
  const lanes = directAccessState(deps).lanes;
  const previous = lanes.get(hostId) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(work);

  const tail = task.then(
    () => undefined,
    () => undefined,
  );

  lanes.set(hostId, tail);
  void tail.then(() => {
    if (lanes.get(hostId) === tail) lanes.delete(hostId);
  });

  return task;
}

export function createDirectProof(
  deps: Deps,
  hostId: string,
  serverUrl: string,
  oldSessionId: string,
): Proof {
  return createProof(deps, hostId, serverUrl, oldSessionId, "handoff");
}

export function createCurrentPrimaryProof(
  deps: Deps,
  hostId: string,
  serverUrl: string,
  sessionId: string,
): Proof {
  return createProof(deps, hostId, serverUrl, sessionId, "current-primary");
}

function createProof(
  deps: Deps,
  hostId: string,
  serverUrl: string,
  expectedSessionId: string,
  kind: Proof["kind"],
): Proof {
  const state = directAccessState(deps);
  const challenge = randomUUID();
  let resolvePrimary!: () => void;

  const primaryReady = new Promise<void>((resolve) => {
    resolvePrimary = resolve;
  });

  const proof = {
    kind,
    hostId,
    challenge,
    serverUrl,
    expectedSessionId,
    expiresAt: Date.now() + 30_000,
    http: false,
    ws: false,
    primary: false,
    committed: false,
    releaseUncertain: false,
    resolvePrimary,
    primaryReady,
  };

  if (kind === "handoff") state.holds.set(hostId, challenge);
  state.proofs.set(challenge, proof);

  return proof;
}

export function observeDirectProof(
  deps: Deps & Pick<WorkSessionDeps, "hub">,
  input: { hostId: string; challenge: string; instanceId: string },
  kind: "http" | "ws",
) {
  const state = directAccessState(deps),
    proof = state.proofs.get(input.challenge);

  if (
    input.instanceId !== state.instanceId ||
    !proof ||
    proof.hostId !== input.hostId ||
    proof.expiresAt < Date.now() ||
    proof.committed ||
    (proof.kind === "current-primary" &&
      deps.hub.getDaemonSessionIdForHost(input.hostId) !==
        proof.expectedSessionId)
  )
    throw new ApiError(
      409,
      "direct_access_proof_refused",
      "Direct route challenge is invalid",
    );
  proof[kind] = true;

  return {
    ok: true as const,
    challenge: proof.challenge,
    instanceId: state.instanceId,
  };
}

export function confirmDirectPrimary(
  deps: Deps,
  hostId: string,
  sessionId: string,
  challenge: string | undefined,
): void {
  if (!challenge) return;

  const state = directAccessState(deps),
    proof = state.proofs.get(challenge),
    row = getDirectRetirement(deps, hostId);

  if (
    proof?.kind !== "handoff" ||
    !proof.committed ||
    proof.expiresAt < Date.now() ||
    !proof.http ||
    !proof.ws ||
    proof.hostId !== hostId ||
    state.holds.get(hostId) !== challenge ||
    proof.expectedSessionId === sessionId ||
    row?.challenge !== challenge ||
    row.serverUrl !== proof.serverUrl
  )
    return;
  deps.db
    .update(serverAccessRetirements)
    .set({ primaryProofRuntimeId: state.instanceId })
    .where(eq(serverAccessRetirements.hostId, hostId))
    .run();
  proof.primary = true;
  state.holds.delete(hostId);
  proof.resolvePrimary();
}
