import type { MobileRealtimeConnectionState } from "../realtime/mobile-realtime";
import type { SessionState } from "../session/session-scheduler";

interface ConnectionSnapshot {
  profile: { id: string };
  client: object | null;
  session: { status: SessionState["status"] | "unsupported" };
}

export interface ServerConnectionStatusInput {
  profileId: string;
  connection: ConnectionSnapshot | null;
  realtime: MobileRealtimeConnectionState;
}

export function describeServerConnection({
  profileId,
  connection,
  realtime,
}: ServerConnectionStatusInput): string {
  if (connection === null || connection.profile.id !== profileId) {
    return "Connecting";
  }

  if (connection.client === null) return "Pair again";

  switch (connection.session.status) {
    case "auth-required":
      return "Sign in again";
    case "error":
      return "Can't sign in";
    case "authenticating":
      return "Signing in";
    case "unsupported":
      return "Pair again";
    case "idle":
    case "authenticated":
      break;
  }

  switch (realtime) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
  }
}
