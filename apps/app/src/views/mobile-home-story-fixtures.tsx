import { useState, type ReactNode } from "react";
import type { PromptTextMention } from "@omnyo/domain";
import {
  NewThreadPromptBoxUI,
  type NewThreadEnvironmentConfig,
  type NewThreadModeConfig,
  type NewThreadProjectConfig,
  type NewThreadWorktreeConfig,
} from "@/components/promptbox/NewThreadPromptBox";
import { ModelPickerStoryQueryProvider } from "../../.ladle/model-picker-query-provider";
import {
  HOST_IDS,
  PROJECT_IDS,
  STORY_PROJECTS,
  STORY_PROJECT_SOURCES,
  STORY_WORKTREE_OPTIONS,
  makeAttachmentsConfig,
  makeExecutionControlsProps,
  makeHost,
  makeTypeaheadConfig,
} from "../../.ladle/story-fixtures";
import { RootComposeCompactHome } from "./RootComposeCompactHome";

const noop = () => {};

const storyEnvironment: NewThreadEnvironmentConfig = {
  value: `host:${HOST_IDS.local}:local`,
  sources: STORY_PROJECT_SOURCES,
  host: makeHost({ id: HOST_IDS.local }),
  isLocal: true,
};

const storyWorktree: NewThreadWorktreeConfig = {
  options: STORY_WORKTREE_OPTIONS,
  value: null,
  onChange: noop,
};

const storyProject: NewThreadProjectConfig = {
  projects: STORY_PROJECTS,
  value: PROJECT_IDS.omnyo,
  onChange: noop,
};

const storyModeConfig = {
  environment: storyEnvironment,
  worktree: storyWorktree,
  permission: {
    value: "auto",
    options: [
      { value: "accept-edits", label: "Accept Edits" },
      { value: "auto", label: "Approve for me" },
      { value: "full", label: "Full Access", tone: "warning" },
    ],
    onChange: noop,
    supported: true,
  },
} satisfies NewThreadModeConfig;

const storyExecution = makeExecutionControlsProps();

export function StoryComposer({
  initialValue = "",
}: {
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [mentionRanges, setMentionRanges] = useState<PromptTextMention[]>([]);

  return (
    <ModelPickerStoryQueryProvider>
      <NewThreadPromptBoxUI
        mentionMenuPlacement="top"
        id="story-compact-home-composer"
        value={value}
        mentionRanges={mentionRanges}
        onChange={(nextValue, nextMentionRanges) => {
          setValue(nextValue);
          setMentionRanges(nextMentionRanges);
        }}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={{
          currentDraft: { text: "", mentions: [], attachments: [] },
          entries: [],
          onSelectEntry: noop,
        }}
        typeahead={makeTypeaheadConfig()}
        attachments={makeAttachmentsConfig()}
        modeConfig={storyModeConfig}
        project={storyProject}
        execution={storyExecution}
      />
    </ModelPickerStoryQueryProvider>
  );
}

export function CompactHomePage({ composerValue }: { composerValue?: string }) {
  return (
    <RootComposeCompactHome
      composer={<StoryComposer initialValue={composerValue} />}
    >
      {null}
    </RootComposeCompactHome>
  );
}

export function PhoneFrame({
  children,
  heightClass = "h-[852px]",
}: {
  children: ReactNode;
  heightClass?: string;
}) {
  return (
    <div
      className={`flex ${heightClass} w-[393px] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background`}
    >
      {children}
    </div>
  );
}
