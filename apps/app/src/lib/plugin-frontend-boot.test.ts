// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { appQueryClient } from "./app-query-client";
import { bootPluginFrontends } from "./plugin-frontend";
import { requestToaster } from "@/components/ui/app-toast-runtime";

vi.mock("@/components/ui/app-toast-runtime", () => ({
  requestToaster: vi.fn(),
  whenToasterSettled: () => new Promise<void>(() => {}),
}));

afterEach(() => vi.restoreAllMocks());

it("loads plugin frontends while the lazy host toaster is still unavailable", async () => {
  const fetchQuery = vi
    .spyOn(appQueryClient, "fetchQuery")
    .mockResolvedValue([]);

  const completed = await Promise.race([
    bootPluginFrontends().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
  ]);

  expect(completed).toBe(true);

  expect(requestToaster).toHaveBeenCalledOnce();
  expect(fetchQuery).toHaveBeenCalledOnce();
});
