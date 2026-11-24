import type {
  ProjectResponse,
  ProjectWithThreadsResponse,
  SidebarBootstrapResponse,
} from "@omnyo/server-contract";

export function makeProjectResponse(
  overrides: Partial<ProjectResponse> = {},
): ProjectResponse {
  return {
    id: "proj_test",
    kind: "standard",
    name: "Test project",
    gitRemoteUrl: null,
    sources: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeProjectWithThreadsResponse(
  overrides: Partial<ProjectWithThreadsResponse> = {},
): ProjectWithThreadsResponse {
  return {
    ...makeProjectResponse(),
    threads: [],
    defaultExecutionOptions: null,
    ...overrides,
  };
}

export function makeSidebarBootstrapResponse(
  overrides: Partial<SidebarBootstrapResponse> = {},
): SidebarBootstrapResponse {
  const projects = overrides.projects ?? [makeProjectWithThreadsResponse()];

  const personalProject =
    overrides.personalProject ??
    makeProjectWithThreadsResponse({
      id: "proj_personal",
      kind: "personal",
      name: "Personal",
    });

  return {
    sections: [],
    groups: [],
    projects,
    personalProject,
    orderedProjectIds: [...projects, personalProject].map(
      (project) => project.id,
    ),
    ...overrides,
  };
}
