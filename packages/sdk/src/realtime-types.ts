import type { ChangedMessage } from "@omnyo/domain";

export type OmnyoRealtimeUnsubscribe = () => void;

export type OmnyoRealtimeEventName =
  | "thread:changed"
  | "project:changed"
  | "environment:changed"
  | "host:changed"
  | "system:changed"
  | "system:config-changed"
  | "realtime:connection";

export type ThreadRealtimeEvent = Extract<ChangedMessage, { entity: "thread" }>;

export type ProjectRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "project" }
>;

export type EnvironmentRealtimeEvent = Extract<
  ChangedMessage,
  { entity: "environment" }
>;

export type HostRealtimeEvent = Extract<ChangedMessage, { entity: "host" }>;

export type SystemRealtimeEvent = Extract<ChangedMessage, { entity: "system" }>;

export type OmnyoRealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface OmnyoRealtimeConnectionEvent {
  reconnectDelayMs: number | null;
  reconnected: boolean;
  state: OmnyoRealtimeConnectionState;
}

export interface OmnyoRealtimeEventMap {
  "thread:changed": ThreadRealtimeEvent;
  "project:changed": ProjectRealtimeEvent;
  "environment:changed": EnvironmentRealtimeEvent;
  "host:changed": HostRealtimeEvent;
  "system:changed": SystemRealtimeEvent;
  "system:config-changed": SystemRealtimeEvent;
  "realtime:connection": OmnyoRealtimeConnectionEvent;
}

export type OmnyoRealtimeCallback<TEventName extends OmnyoRealtimeEventName> = (
  event: OmnyoRealtimeEventMap[TEventName],
) => void;

export interface ThreadRealtimeSubscribeArgs {
  callback: OmnyoRealtimeCallback<"thread:changed">;
  event: "thread:changed";
  threadId?: string;
}

export interface ProjectRealtimeSubscribeArgs {
  callback: OmnyoRealtimeCallback<"project:changed">;
  event: "project:changed";
  projectId?: string;
}

export interface EnvironmentRealtimeSubscribeArgs {
  callback: OmnyoRealtimeCallback<"environment:changed">;
  environmentId?: string;
  event: "environment:changed";
}

export interface HostRealtimeSubscribeArgs {
  callback: OmnyoRealtimeCallback<"host:changed">;
  event: "host:changed";
  hostId?: string;
}

export interface SystemRealtimeSubscribeArgs {
  callback: OmnyoRealtimeCallback<"system:changed">;
  event: "system:changed";
}

export interface SystemConfigRealtimeSubscribeArgs {
  callback: OmnyoRealtimeCallback<"system:config-changed">;
  event: "system:config-changed";
}

export interface RealtimeConnectionSubscribeArgs {
  callback: OmnyoRealtimeCallback<"realtime:connection">;
  event: "realtime:connection";
}

export type OmnyoRealtimeSubscribeArgsUnion =
  | ThreadRealtimeSubscribeArgs
  | ProjectRealtimeSubscribeArgs
  | EnvironmentRealtimeSubscribeArgs
  | HostRealtimeSubscribeArgs
  | SystemRealtimeSubscribeArgs
  | SystemConfigRealtimeSubscribeArgs
  | RealtimeConnectionSubscribeArgs;

export type OmnyoRealtimeSubscribeArgs<
  TEventName extends OmnyoRealtimeEventName = OmnyoRealtimeEventName,
> = Extract<OmnyoRealtimeSubscribeArgsUnion, { event: TEventName }>;

export interface OmnyoRealtime {
  subscribe<TEventName extends OmnyoRealtimeEventName>(
    args: OmnyoRealtimeSubscribeArgs<TEventName>,
  ): OmnyoRealtimeUnsubscribe;
}
