import { useState } from "react";
import { ProjectSelector, type ProjectSelectorOption } from "./ProjectSelector";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Project Selector",
};

const projects: readonly ProjectSelectorOption[] = [
  { id: "proj_omnyo", name: "Omnyo" },
  { id: "proj_pierre", name: "pierre" },
];

const noop = () => {};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="project selected"
        hint="trigger shows the project name + Folder icon"
      >
        <ProjectSelector
          projects={projects}
          value="proj_omnyo"
          onChange={noop}
        />
      </StoryRow>
      <StoryRow
        label="no project selected — required mode"
        hint="allowNoProject=false (default): trigger falls back to the first project so it is never blank"
      >
        <ProjectSelector projects={projects} value={null} onChange={noop} />
      </StoryRow>
      <StoryRow
        label="no project selected — optional mode"
        hint='allowNoProject=true: trigger shows "No project" + FolderMinus icon, menu adds "Don&apos;t work in a project" item'
      >
        <ProjectSelector
          projects={projects}
          value={null}
          onChange={noop}
          allowNoProject
        />
      </StoryRow>
      <StoryRow
        label="open menu"
        hint="allowNoProject=true; click to open, or see the Open Menu story"
      >
        <ProjectSelectorInteractive allowNoProject defaultOpen={false} />
      </StoryRow>
      <StoryRow
        label="open menu with actions"
        hint="createProject + allowNoProject; click to open, or see the Open Menu With Actions story"
      >
        <ProjectSelectorInteractive
          allowNoProject
          createProject
          defaultOpen={false}
        />
      </StoryRow>
      <StoryRow
        label="no projects"
        hint="empty project list; click to open, or see the No Projects story"
      >
        <ProjectSelector
          projects={[]}
          value={null}
          onChange={noop}
          allowNoProject
          createProject={{ onCreate: noop }}
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}

function ProjectSelectorInteractive({
  allowNoProject = false,
  createProject = false,
  defaultOpen,
}: {
  allowNoProject?: boolean;
  createProject?: boolean;
  defaultOpen: boolean;
}) {
  const [value, setValue] = useState<string | null>("proj_omnyo");

  return (
    <ProjectSelector
      projects={projects}
      value={value}
      onChange={setValue}
      allowNoProject={allowNoProject}
      createProject={createProject ? { onCreate: noop } : undefined}
      defaultOpen={defaultOpen}
      modal={false}
    />
  );
}

export function OpenMenu() {
  return (
    <StoryCard>
      <StoryRow
        label="open menu"
        hint="defaultOpen + modal=false (allowNoProject=true — shows the no-project item below a separator)"
      >
        <ProjectSelectorInteractive allowNoProject defaultOpen />
      </StoryRow>
    </StoryCard>
  );
}

export function OpenMenuWithActions() {
  return (
    <StoryCard>
      <StoryRow
        label="open menu with actions"
        hint="createProject + allowNoProject share one separator below the project list"
      >
        <ProjectSelectorInteractive allowNoProject createProject defaultOpen />
      </StoryRow>
    </StoryCard>
  );
}

export function NoProjects() {
  return (
    <StoryCard>
      <StoryRow
        label="no projects"
        hint='empty project list with allowNoProject=true — menu adds a "New project" item'
      >
        <ProjectSelector
          projects={[]}
          value={null}
          onChange={noop}
          allowNoProject
          createProject={{ onCreate: noop }}
          defaultOpen
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}
