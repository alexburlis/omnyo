import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { appLinkOrigins, canonicalAppOrigin } from "./canonical-app-origin";

function clientWithServerUrl(serverUrl: string | null): QueryClient {
  const client = new QueryClient();

  if (serverUrl !== null)
    client.setQueryData(systemConfigQueryKey(), { serverUrl });

  return client;
}

describe("canonicalAppOrigin", () => {
  it("uses the server's canonical URL instead of the alias the app loaded from", () => {
    const client = clientWithServerUrl("https://o.example.test/");

    expect(canonicalAppOrigin(client, "https://omnyo.example.test")).toBe(
      "https://o.example.test",
    );
    expect(appLinkOrigins(client, "https://omnyo.example.test")).toEqual([
      "https://o.example.test",
      "https://omnyo.example.test",
    ]);
  });

  it("uses the current origin until the server config has loaded", () => {
    const client = clientWithServerUrl(null);

    expect(canonicalAppOrigin(client, "https://omnyo.example.test")).toBe(
      "https://omnyo.example.test",
    );
    expect(appLinkOrigins(client, "https://omnyo.example.test")).toEqual([
      "https://omnyo.example.test",
    ]);
  });
});
