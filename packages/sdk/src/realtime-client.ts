import type {
  ChangedMessage,
  ClientMessage,
  RealtimeSubscriptionTarget,
} from "@omnyo/domain";
import { RealtimeTargetRetention } from "@omnyo/domain";
import { serverMessageLenientSchema } from "@omnyo/server-contract";
import { resolveRealtimeUrl } from "./realtime-url.js";
import type {
  OmnyoRealtime,
  OmnyoRealtimeCallback,
  OmnyoRealtimeConnectionEvent,
  OmnyoRealtimeEventMap,
  OmnyoRealtimeEventName,
  OmnyoRealtimeSubscribeArgs,
  OmnyoRealtimeSubscribeArgsUnion,
  OmnyoRealtimeUnsubscribe,
  SystemRealtimeEvent,
} from "./realtime-types.js";
import type {
  OmnyoRealtimeSocket,
  OmnyoRealtimeSocketFactory,
  OmnyoRealtimeSocketMessageEvent,
  OmnyoSdkTransport,
} from "./transport.js";

const SOCKET_CONNECTING = 0;

const SOCKET_OPEN = 1;

const INITIAL_RECONNECT_DELAY_MS = 1000;

const MAX_RECONNECT_DELAY_MS = 30_000;

const RECONNECT_DELAY_MULTIPLIER = 1.5;

interface CreateOmnyoRealtimeClientArgs {
  transport: OmnyoSdkTransport;
}

interface OptionalTargetIdMatchesArgs {
  messageId: string | undefined;
  selectorId: string | undefined;
}

type IdScopedChangedEventName =
  | "thread:changed"
  | "project:changed"
  | "environment:changed"
  | "host:changed";

type UnscopedChangedEventName = "system:changed" | "system:config-changed";

interface IdScopedChangedListenerRecord<
  TEventName extends IdScopedChangedEventName,
> {
  active: boolean;
  callback: OmnyoRealtimeCallback<TEventName>;
  event: TEventName;
  selectorId?: string;
  target: RealtimeSubscriptionTarget;
}

interface UnscopedChangedListenerRecord<
  TEventName extends UnscopedChangedEventName,
> {
  active: boolean;
  callback: OmnyoRealtimeCallback<TEventName>;
  event: TEventName;
  target: RealtimeSubscriptionTarget;
}

type ChangedListenerRecord =
  | {
      [
        TEventName in IdScopedChangedEventName
      ]: IdScopedChangedListenerRecord<TEventName>;
    }[IdScopedChangedEventName]
  | {
      [
        TEventName in UnscopedChangedEventName
      ]: UnscopedChangedListenerRecord<TEventName>;
    }[UnscopedChangedEventName];

interface ConnectionListenerRecord {
  active: boolean;
  callback: OmnyoRealtimeCallback<"realtime:connection">;
  event: "realtime:connection";
}

type RealtimeListenerRecord = ChangedListenerRecord | ConnectionListenerRecord;

function threadRealtimeTarget(
  threadId: string | undefined,
): RealtimeSubscriptionTarget {
  return threadId
    ? { kind: "thread-detail", threadId }
    : { kind: "thread-list" };
}

function projectRealtimeTarget(
  projectId: string | undefined,
): RealtimeSubscriptionTarget {
  return projectId
    ? { kind: "project-detail", projectId }
    : { kind: "project-list" };
}

function environmentRealtimeTarget(
  environmentId: string | undefined,
): RealtimeSubscriptionTarget {
  return environmentId
    ? { kind: "environment-detail", environmentId }
    : { kind: "environment-list" };
}

function hostRealtimeTarget(
  hostId: string | undefined,
): RealtimeSubscriptionTarget {
  return hostId ? { kind: "host-detail", hostId } : { kind: "host-list" };
}

function optionalTargetIdMatches(args: OptionalTargetIdMatchesArgs): boolean {
  return args.selectorId === undefined || args.messageId === args.selectorId;
}

export function createRealtimeSocketAdapter(socket: {
  close(): void;
  readonly readyState: number;
  send(data: string): void;
}): OmnyoRealtimeSocket {
  return {
    close: () => socket.close(),
    onclose: null,
    onerror: null,
    onmessage: null,
    onopen: null,
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
  };
}

export function wrapStandardWebsocket(socket: WebSocket): OmnyoRealtimeSocket {
  const adapter = createRealtimeSocketAdapter(socket);
  socket.onopen = () => adapter.onopen?.();
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  socket.onclose = () => adapter.onclose?.();
  socket.onerror = () => adapter.onerror?.();

  return adapter;
}

function resolveDefaultWebsocketFactory(): OmnyoRealtimeSocketFactory | null {
  if (typeof WebSocket === "undefined") {
    return null;
  }

  return (url) => wrapStandardWebsocket(new WebSocket(url));
}

function isTargetedListener(
  listener: RealtimeListenerRecord,
): listener is Exclude<RealtimeListenerRecord, ConnectionListenerRecord> {
  return listener.event !== "realtime:connection";
}

function isIdScopedChangedListenerFor<
  TEventName extends IdScopedChangedEventName,
>(
  listener: RealtimeListenerRecord | IdScopedChangedListenerRecord<TEventName>,
  event: TEventName,
): listener is IdScopedChangedListenerRecord<TEventName> {
  return listener.event === event;
}

export class OmnyoRealtimeClient implements OmnyoRealtime {
  private readonly listeners = new Set<RealtimeListenerRecord>();
  private readonly targetSubscriptions = new RealtimeTargetRetention();
  private readonly transport: OmnyoSdkTransport;
  private lastConnectionEvent: OmnyoRealtimeConnectionEvent | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private reconnectingAfterUnexpectedClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectSocketReady: ((error: Error) => void) | null = null;
  private resolveSocketReady: (() => void) | null = null;
  private socket: OmnyoRealtimeSocket | null = null;
  private socketReadyPromise: Promise<void> | null = null;

  constructor(args: CreateOmnyoRealtimeClientArgs) {
    this.transport = args.transport;
  }

  subscribe<TEventName extends OmnyoRealtimeEventName>(
    args: OmnyoRealtimeSubscribeArgs<TEventName>,
  ): OmnyoRealtimeUnsubscribe {
    return this.addListener(args);
  }

  private addListener(
    args: OmnyoRealtimeSubscribeArgsUnion,
  ): OmnyoRealtimeUnsubscribe {
    switch (args.event) {
      case "thread:changed":
        return this.activateListener({
          active: true,
          callback: args.callback,
          event: args.event,
          selectorId: args.threadId,
          target: threadRealtimeTarget(args.threadId),
        });
      case "project:changed":
        return this.activateListener({
          active: true,
          callback: args.callback,
          event: args.event,
          selectorId: args.projectId,
          target: projectRealtimeTarget(args.projectId),
        });
      case "environment:changed":
        return this.activateListener({
          active: true,
          callback: args.callback,
          event: args.event,
          selectorId: args.environmentId,
          target: environmentRealtimeTarget(args.environmentId),
        });
      case "host:changed":
        return this.activateListener({
          active: true,
          callback: args.callback,
          event: args.event,
          selectorId: args.hostId,
          target: hostRealtimeTarget(args.hostId),
        });
      case "system:changed":
        return this.activateListener({
          active: true,
          callback: args.callback,
          event: args.event,
          target: { kind: "system" },
        });
      case "system:config-changed":
        return this.activateListener({
          active: true,
          callback: args.callback,
          event: args.event,
          target: { kind: "system" },
        });
      case "realtime:connection":
        return this.addConnectionListener({
          active: true,
          callback: args.callback,
          event: args.event,
        });
    }
  }

  private addConnectionListener(
    listener: ConnectionListenerRecord,
  ): OmnyoRealtimeUnsubscribe {
    const unsubscribe = this.activateListener(listener);
    const snapshot = this.lastConnectionEvent;

    if (snapshot) {
      queueMicrotask(() => {
        if (listener.active && this.lastConnectionEvent === snapshot) {
          this.callListener(listener.callback, snapshot);
        }
      });
    }

    return unsubscribe;
  }

  private activateListener(
    listener: RealtimeListenerRecord,
  ): OmnyoRealtimeUnsubscribe {
    this.listeners.add(listener);

    if (isTargetedListener(listener)) {
      this.addTarget(listener.target);

      try {
        void this.connectSocket().catch((error) => {
          if (listener.active) {
            console.error("Omnyo realtime connection failed", error);
          }
        });
      } catch (error) {
        this.removeListener(listener);
        throw error;
      }
    }

    return () => this.removeListener(listener);
  }

  private removeListener(listener: RealtimeListenerRecord): void {
    if (!listener.active) {
      return;
    }

    listener.active = false;
    this.listeners.delete(listener);

    if (isTargetedListener(listener)) {
      this.removeTarget(listener.target);
    }

    this.closeSocketIfIdle();
  }

  private addTarget(target: RealtimeSubscriptionTarget): void {
    if (!this.targetSubscriptions.retain(target)) return;

    if (this.socket?.readyState === SOCKET_OPEN) {
      this.sendTargetMessage("subscribe", target);
    }
  }

  private removeTarget(target: RealtimeSubscriptionTarget): void {
    if (!this.targetSubscriptions.release(target)) return;

    if (this.socket?.readyState === SOCKET_OPEN) {
      this.sendTargetMessage("unsubscribe", target);
    }
  }

  private connectSocket(): Promise<void> {
    if (this.targetSubscriptions.size === 0) {
      return Promise.resolve();
    }

    if (
      this.socket &&
      (this.socket.readyState === SOCKET_OPEN ||
        this.socket.readyState === SOCKET_CONNECTING)
    ) {
      return this.ensureSocketReadyPromise();
    }

    const websocketFactory =
      this.transport.websocket ?? resolveDefaultWebsocketFactory();

    if (!websocketFactory) {
      throw new Error(
        "Omnyo SDK realtime requires a WebSocket implementation. Pass websocket when creating the transport.",
      );
    }

    const socket = websocketFactory(
      resolveRealtimeUrl({ transport: this.transport }),
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.resetSocketReadyPromise();
    const socketReadyPromise = this.ensureSocketReadyPromise();
    const reconnected = this.reconnectingAfterUnexpectedClose;
    this.socket = socket;
    this.emitConnection({
      state: "connecting",
      reconnected,
      reconnectDelayMs: null,
    });

    socket.onopen = () => {
      if (this.socket !== socket) {
        return;
      }

      const openedAfterReconnect = this.reconnectingAfterUnexpectedClose;
      this.reconnectingAfterUnexpectedClose = false;
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

      for (const target of this.targetSubscriptions.values()) {
        this.sendTargetMessage("subscribe", target);
      }

      this.resolveSocketReadyPromise();
      this.closeSocketIfIdle();

      if (this.socket !== socket) {
        return;
      }

      this.emitConnection({
        state: "connected",
        reconnected: openedAfterReconnect,
        reconnectDelayMs: null,
      });
    };

    socket.onmessage = (event) => {
      this.handleSocketMessage(event);
    };

    const handleClosed = () => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;
      this.clearSocketReadyPromise(
        new Error("Omnyo realtime socket closed before it became ready."),
      );

      if (this.targetSubscriptions.size === 0) {
        if (this.lastConnectionEvent?.state !== "disconnected") {
          this.emitConnection({
            state: "disconnected",
            reconnected: false,
            reconnectDelayMs: null,
          });
        }

        return;
      }

      this.reconnectingAfterUnexpectedClose = true;
      const reconnectDelayMs = this.reconnectDelayMs;
      this.emitConnection({
        state: "disconnected",
        reconnected: false,
        reconnectDelayMs,
      });

      if (this.reconnectTimer || this.socket) {
        return;
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectDelayMs = Math.min(
          reconnectDelayMs * RECONNECT_DELAY_MULTIPLIER,
          MAX_RECONNECT_DELAY_MS,
        );

        try {
          void this.connectSocket().catch((error) => {
            console.error("Omnyo realtime reconnect failed", error);
          });
        } catch (error) {
          console.error("Omnyo realtime reconnect failed", error);
        }
      }, reconnectDelayMs);
    };

    socket.onclose = handleClosed;

    let closeRequested = false;
    socket.onerror = () => {
      if (closeRequested) return;
      closeRequested = true;
      socket.close();
      handleClosed();
    };

    return socketReadyPromise;
  }

  private closeSocketIfIdle(): void {
    if (this.targetSubscriptions.size > 0) {
      return;
    }

    let canceledPendingReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      canceledPendingReconnect = true;
    }

    this.reconnectingAfterUnexpectedClose = false;
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    this.clearSocketReadyPromise(
      new Error(
        "Omnyo realtime socket closed because there are no active targets.",
      ),
    );

    if (
      this.socket &&
      (this.socket.readyState === SOCKET_OPEN ||
        this.socket.readyState === SOCKET_CONNECTING)
    ) {
      const socket = this.socket;
      this.socket = null;
      this.emitConnection({
        state: "disconnected",
        reconnected: false,
        reconnectDelayMs: null,
      });
      socket.close();

      return;
    }

    if (canceledPendingReconnect) {
      this.emitConnection({
        state: "disconnected",
        reconnected: false,
        reconnectDelayMs: null,
      });
    }
  }

  private handleSocketMessage(event: OmnyoRealtimeSocketMessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    let parsedMessage: unknown;

    try {
      parsedMessage = JSON.parse(event.data);
    } catch (error) {
      console.error(
        "Omnyo realtime ignored malformed websocket message",
        error,
      );

      return;
    }

    if (
      typeof parsedMessage === "object" &&
      parsedMessage !== null &&
      "type" in parsedMessage &&
      typeof (parsedMessage as { type: unknown }).type === "string" &&
      (parsedMessage as { type: string }).type !== "changed"
    ) {
      return;
    }

    const parseResult = serverMessageLenientSchema.safeParse(parsedMessage);

    if (!parseResult.success) {
      console.error(
        "Omnyo realtime ignored invalid websocket message",
        parseResult.error,
      );

      return;
    }

    this.dispatchChangedMessage(parseResult.data);
  }

  private dispatchChangedMessage(message: ChangedMessage): void {
    switch (message.entity) {
      case "thread":
        this.dispatchIdScopedChangedMessage("thread:changed", message);
        break;
      case "project":
        this.dispatchIdScopedChangedMessage("project:changed", message);
        break;
      case "environment":
        this.dispatchIdScopedChangedMessage("environment:changed", message);
        break;
      case "host":
        this.dispatchIdScopedChangedMessage("host:changed", message);
        break;
      case "system":
        this.dispatchSystemChangedMessage(message);
        break;
    }
  }

  private dispatchIdScopedChangedMessage<
    TEventName extends IdScopedChangedEventName,
  >(event: TEventName, message: OmnyoRealtimeEventMap[TEventName]): void {
    for (const listener of this.listenerSnapshot()) {
      if (
        !isIdScopedChangedListenerFor(listener, event) ||
        !listener.active ||
        !optionalTargetIdMatches({
          messageId: message.id,
          selectorId: listener.selectorId,
        })
      ) {
        continue;
      }

      this.callListener(listener.callback, message);
    }
  }

  private dispatchSystemChangedMessage(message: SystemRealtimeEvent): void {
    for (const listener of this.listenerSnapshot()) {
      if (!listener.active) {
        continue;
      }

      if (listener.event === "system:changed") {
        this.callListener(listener.callback, message);
      }

      if (
        listener.event === "system:config-changed" &&
        message.changes.includes("config-changed")
      ) {
        this.callListener(listener.callback, message);
      }
    }
  }

  private ensureSocketReadyPromise(): Promise<void> {
    if (!this.socketReadyPromise) {
      this.resetSocketReadyPromise();
    }

    if (!this.socketReadyPromise) {
      throw new Error(
        "Omnyo SDK realtime socket readiness was not initialized.",
      );
    }

    return this.socketReadyPromise;
  }

  private resetSocketReadyPromise(): void {
    this.clearSocketReadyPromise(
      new Error("Omnyo realtime socket closed before it became ready."),
    );
    this.socketReadyPromise = new Promise((resolve, reject) => {
      this.resolveSocketReady = resolve;
      this.rejectSocketReady = reject;
    });
  }

  private resolveSocketReadyPromise(): void {
    if (!this.resolveSocketReady) {
      return;
    }

    this.resolveSocketReady();
    this.resolveSocketReady = null;
    this.rejectSocketReady = null;
  }

  private clearSocketReadyPromise(error: Error): void {
    this.rejectSocketReadyPromise(error);
    this.socketReadyPromise = null;
  }

  private rejectSocketReadyPromise(error: Error): void {
    if (!this.rejectSocketReady) {
      return;
    }

    this.rejectSocketReady(error);
    this.resolveSocketReady = null;
    this.rejectSocketReady = null;
  }

  private sendTargetMessage(
    type: "subscribe" | "unsubscribe",
    target: RealtimeSubscriptionTarget,
  ): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) {
      return;
    }

    const message: ClientMessage = { type, target };
    this.socket.send(JSON.stringify(message));
  }

  private emitConnection(event: OmnyoRealtimeConnectionEvent): void {
    this.lastConnectionEvent = event;

    for (const listener of this.listenerSnapshot()) {
      if (listener.event !== "realtime:connection" || !listener.active) {
        continue;
      }

      this.callListener(listener.callback, event);
    }
  }

  private listenerSnapshot(): RealtimeListenerRecord[] {
    return [...this.listeners];
  }

  private callListener<TEventName extends OmnyoRealtimeEventName>(
    callback: OmnyoRealtimeCallback<TEventName>,
    event: Parameters<OmnyoRealtimeCallback<TEventName>>[0],
  ): void {
    try {
      callback(event);
    } catch (error) {
      console.error("Omnyo realtime listener failed", error);
    }
  }
}

export function createOmnyoRealtimeClient(
  args: CreateOmnyoRealtimeClientArgs,
): OmnyoRealtimeClient {
  return new OmnyoRealtimeClient(args);
}
