import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  makeProjectResponse,
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { sidebarNavigationQueryKey } from "../queries/query-keys";
import {
  applyProjectCreateResult,
  applyProjectDeleteResult,
} from "./project-cache-owner";

describe("project sidebar cache order", () => {
  it("appends new projects and removes deleted projects without moving Personal", () => {
    const queryClient = new QueryClient();

    const navigation = makeSidebarBootstrapResponse({
      projects: [makeProjectWithThreadsResponse({ id: "proj_old" })],
      orderedProjectIds: ["proj_personal", "proj_old"],
    });

    queryClient.setQueryData(sidebarNavigationQueryKey(), navigation);
    applyProjectCreateResult({
      queryClient,
      project: makeProjectResponse({ id: "proj_new" }),
    });
    expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toMatchObject(
      {
        orderedProjectIds: ["proj_personal", "proj_old", "proj_new"],
      },
    );

    applyProjectDeleteResult({ queryClient, projectId: "proj_old" });
    expect(queryClient.getQueryData(sidebarNavigationQueryKey())).toMatchObject(
      {
        orderedProjectIds: ["proj_personal", "proj_new"],
        projects: [expect.objectContaining({ id: "proj_new" })],
      },
    );
  });
});
