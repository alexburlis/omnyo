import type {
  InboxActRequest,
  InboxActResult,
  InboxEventCheckResponse,
  InboxEventReportResponse,
  InboxEventSourcesResponse,
  InboxFailureAcknowledgeRequest,
  InboxFailureAcknowledgeResponse,
  InboxFailureListResponse,
  InboxPendingEventsResponse,
  InboxProducerKind,
  InboxProducerResponse,
  InboxProducerVerdict,
  InboxRetryDeclineRequest,
  InboxRetryDeclineResponse,
  InboxSnapshot,
  InboxWaitActionResponse,
  InboxWaitDetailResponse,
  InboxWaitListResponse,
  InboxWaitRegisterRequest,
  InboxWaitRegisterResponse,
} from "@omnyo/domain";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type InboxWaitRegisterInput = Omit<
  InboxWaitRegisterRequest,
  | "chats"
  | "events"
  | "check"
  | "report"
  | "readiness"
  | "by"
  | "resume"
  | "after"
> &
  Partial<
    Pick<
      InboxWaitRegisterRequest,
      | "chats"
      | "events"
      | "check"
      | "report"
      | "readiness"
      | "by"
      | "resume"
      | "after"
    >
  >;

export interface ExperimentalInboxArea {
  snapshot(args?: { signal?: AbortSignal }): Promise<InboxSnapshot>;
  act(args: {
    request: InboxActRequest;
    signal?: AbortSignal;
  }): Promise<InboxActResult>;
  undo(args: { moveId: string; signal?: AbortSignal }): Promise<InboxActResult>;
  failures(args: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<InboxFailureListResponse>;
  acknowledgeFailure(
    args: InboxFailureAcknowledgeRequest & {
      threadId: string;
      failureId: string;
      signal?: AbortSignal;
    },
  ): Promise<InboxFailureAcknowledgeResponse>;
  waits(args: {
    threadId: string;
    signal?: AbortSignal;
  }): Promise<InboxWaitListResponse>;
  registerWait(args: {
    threadId: string;
    wait: InboxWaitRegisterInput;
    signal?: AbortSignal;
  }): Promise<InboxWaitRegisterResponse>;
  rearmWait(args: {
    threadId: string;
    waitId: string;
    signal?: AbortSignal;
  }): Promise<InboxWaitActionResponse>;
  metWait(args: {
    threadId: string;
    waitId: string;
    condition: string;
    result?: string | null;
    signal?: AbortSignal;
  }): Promise<InboxWaitActionResponse>;
  doneWait(args: {
    threadId: string;
    waitId: string;
    signal?: AbortSignal;
  }): Promise<InboxWaitActionResponse>;
  cancelWait(args: {
    threadId: string;
    waitId: string;
    signal?: AbortSignal;
  }): Promise<InboxWaitActionResponse>;
  wait(args: {
    threadId: string;
    waitId: string;
    signal?: AbortSignal;
  }): Promise<InboxWaitDetailResponse>;
  startProducer(args: {
    threadId: string;
    kind: InboxProducerKind;
    label: string;
    signal?: AbortSignal;
  }): Promise<InboxProducerResponse>;
  settleProducer(args: {
    threadId: string;
    producerId: string;
    verdict: InboxProducerVerdict;
    summary: string;
    signal?: AbortSignal;
  }): Promise<InboxProducerResponse>;
  declineRetry(
    args: InboxRetryDeclineRequest & { threadId: string; signal?: AbortSignal },
  ): Promise<InboxRetryDeclineResponse>;
  pendingEvents(args: {
    prefix: string;
    signal?: AbortSignal;
  }): Promise<InboxPendingEventsResponse>;
  reportEvent(args: {
    key: string;
    result: string;
    signal?: AbortSignal;
  }): Promise<InboxEventReportResponse>;
  eventSources(args?: {
    signal?: AbortSignal;
  }): Promise<InboxEventSourcesResponse>;
  checkEvent(args: {
    key: string;
    signal?: AbortSignal;
  }): Promise<InboxEventCheckResponse>;
}

export function createInboxArea({
  transport,
}: CreateSdkAreaArgs): ExperimentalInboxArea {
  const waitPath = (args: { threadId: string; waitId: string }) => ({
    param: { id: args.threadId, waitId: args.waitId },
  });

  return {
    snapshot: (args = {}) =>
      transport.readJson(
        transport.api.v1.inbox.$get({}, ...signalRequestArgs(args.signal)),
      ),
    act: (args) =>
      transport.readJson(
        transport.api.v1.inbox.act.$post(
          { json: args.request },
          ...signalRequestArgs(args.signal),
        ),
      ),
    undo: (args) =>
      transport.readJson(
        transport.api.v1.inbox.undo.$post(
          { json: { moveId: args.moveId } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    failures: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].failures.$get(
          { param: { id: args.threadId } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    acknowledgeFailure: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].failures[
          ":failureId"
        ].acknowledge.$post(
          {
            param: { id: args.threadId, failureId: args.failureId },
            json: { turnId: args.turnId, reason: args.reason },
          },
          ...signalRequestArgs(args.signal),
        ),
      ),
    waits: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits.$get(
          { param: { id: args.threadId } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    registerWait: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits.$post(
          {
            param: { id: args.threadId },
            json: {
              chats: [],
              events: [],
              check: null,
              report: null,
              readiness: "all",
              by: null,
              resume: null,
              after: null,
              ...args.wait,
            },
          },
          ...signalRequestArgs(args.signal),
        ),
      ),
    rearmWait: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits[":waitId"].rearm.$post(
          waitPath(args),
          ...signalRequestArgs(args.signal),
        ),
      ),
    metWait: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits[":waitId"].met.$post(
          {
            ...waitPath(args),
            json: { condition: args.condition, result: args.result ?? null },
          },
          ...signalRequestArgs(args.signal),
        ),
      ),
    doneWait: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits[":waitId"].done.$post(
          waitPath(args),
          ...signalRequestArgs(args.signal),
        ),
      ),
    cancelWait: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits[":waitId"].cancel.$post(
          waitPath(args),
          ...signalRequestArgs(args.signal),
        ),
      ),
    wait: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].waits[":waitId"].$get(
          waitPath(args),
          ...signalRequestArgs(args.signal),
        ),
      ),
    startProducer: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].producers.$post(
          {
            param: { id: args.threadId },
            json: { kind: args.kind, label: args.label },
          },
          ...signalRequestArgs(args.signal),
        ),
      ),
    pendingEvents: (args) =>
      transport.readJson(
        transport.api.v1.inbox.events.$get(
          { query: { prefix: args.prefix } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    reportEvent: (args) =>
      transport.readJson(
        transport.api.v1.inbox.events.$post(
          { json: { key: args.key, result: args.result } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    eventSources: (args = {}) =>
      transport.readJson(
        transport.api.v1.inbox.events.sources.$get(
          {},
          ...signalRequestArgs(args.signal),
        ),
      ),
    checkEvent: (args) =>
      transport.readJson(
        transport.api.v1.inbox.events.check.$post(
          { json: { key: args.key } },
          ...signalRequestArgs(args.signal),
        ),
      ),
    declineRetry: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].retry.decline.$post(
          {
            param: { id: args.threadId },
            json: {
              turnRequestId: args.turnRequestId,
              reason: args.reason,
              incident: args.incident,
            },
          },
          ...signalRequestArgs(args.signal),
        ),
      ),
    settleProducer: (args) =>
      transport.readJson(
        transport.api.v1.threads[":id"].producers[":producerId"].settle.$post(
          {
            param: { id: args.threadId, producerId: args.producerId },
            json: { verdict: args.verdict, summary: args.summary },
          },
          ...signalRequestArgs(args.signal),
        ),
      ),
  };
}
