import { z } from "zod";
import {
  migrateLegacyRelayApexUrl,
  migrateLegacyRelayServerUrl,
} from "@omnyo/connect-client";

export const relayRebindInputSchema = z
  .object({
    fromBaseUrl: z.string().url(),
    fromServerUrl: z.string().url(),
    userId: z.string().min(1),
    serverId: z.string().min(1),
    serverLabel: z.string().min(1),
    check: z.boolean(),
  })
  .strict();

export type RelayRebindInput = z.infer<typeof relayRebindInputSchema>;

export function relayRebindTarget(input: RelayRebindInput): {
  baseUrl: string;
  serverUrl: string;
} {
  const baseUrl = migrateLegacyRelayApexUrl(input.fromBaseUrl);
  const serverUrl = migrateLegacyRelayServerUrl(input.fromServerUrl);

  if (
    baseUrl === null ||
    serverUrl === null ||
    new URL(input.fromBaseUrl).origin !== input.fromBaseUrl ||
    new URL(input.fromServerUrl).origin !== input.fromServerUrl ||
    new URL(serverUrl).hostname !==
      `${input.serverLabel}.${new URL(baseUrl).hostname}`
  ) {
    throw new Error(
      "Relay migration requires the checkpointed production or staging origins and server label.",
    );
  }

  return { baseUrl, serverUrl };
}
