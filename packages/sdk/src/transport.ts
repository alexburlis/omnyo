import type { ApiClient } from "@omnyo/server-contract";
import type {
  FetchImplementation,
  JsonBodyOf,
  SdkResponseLike,
} from "./response.js";

export type OmnyoSdkRuntime = "node" | "browser";

export interface OmnyoSdkTransport {
  api: ApiClient["api"];
  baseUrl: string;
  fetch: FetchImplementation;
  realtimeUrl?: string;
  runtime: OmnyoSdkRuntime;
  readJson<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<JsonBodyOf<TResponse>>;
  readVoid<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<void>;
  resolve<TResponse extends SdkResponseLike>(
    response: Promise<TResponse>,
  ): Promise<TResponse>;
  websocket?: OmnyoRealtimeSocketFactory;
}

export interface OmnyoRealtimeSocketMessageEvent {
  data: unknown;
}

export interface OmnyoRealtimeSocket {
  close(): void;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: OmnyoRealtimeSocketMessageEvent) => void) | null;
  onopen: (() => void) | null;
  readyState: number;
  send(data: string): void;
}

export type OmnyoRealtimeSocketFactory = (url: string) => OmnyoRealtimeSocket;

export interface OmnyoSdkContext {}

export interface CreateHttpTransportArgs {
  baseUrl?: string;
  fetch?: FetchImplementation;
  realtimeUrl?: string;
  runtime: OmnyoSdkRuntime;
  websocket?: OmnyoRealtimeSocketFactory;
}
