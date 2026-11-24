import type { ReactNode } from "react";

import { SwitchConcept } from "../concepts";
import { CopyPromptButton, Substeps, Ui } from "../guide-blocks";
import type {
  Guide,
  GuideFaq,
  GuideMeta,
  GuideShot,
  GuideStep,
} from "../guide-types";
import { AGENTS_FAQ, COST_FAQ } from "./faq";

const GENERIC_SETUP_STEP = (
  <>
    Put your setup commands in a <code>.omnyo-env-setup.sh</code> at the repo
    root, list files each worktree needs, like <code>.env</code>, in a{" "}
    <code>.worktreeinclude</code>, and commit both. Each time Omnyo creates a
    worktree, it copies those files in, then runs the script.
  </>
);

type ChatImport = {
  providerId: "claude-code" | "codex";
  sources: string;
};

export type SwitchTool = {
  id: string;
  slug: string;
  name: string;
  conversations: string;
  keepsWorking: string;
  setupStep: ReactNode;
  chatImport: ChatImport | null;
};

export const SWITCH_TOOLS = {
  claude: {
    id: "claude",
    slug: "switch-from-claude-code",
    name: "Claude Code",
    conversations:
      "Claude Code keeps each conversation as a .jsonl file in ~/.claude/projects/ (or $CLAUDE_CONFIG_DIR/projects/ if that is set), in a folder named after the path it ran in.",
    keepsWorking: "Claude Code keeps working while you try Omnyo.",
    setupStep: GENERIC_SETUP_STEP,
    chatImport: {
      providerId: "claude-code",
      sources: "the Claude Code CLI, IDE extension, and desktop app",
    },
  },
  "codex-app": {
    id: "codex-app",
    slug: "switch-from-codex",
    name: "Codex",
    conversations:
      "Codex keeps each conversation as a .jsonl file under ~/.codex/sessions/ (or $CODEX_HOME/sessions/ if that is set). The first line's payload.cwd is the folder it ran in.",
    keepsWorking: "Codex keeps working while you try Omnyo.",
    setupStep: GENERIC_SETUP_STEP,
    chatImport: {
      providerId: "codex",
      sources: "the Codex CLI and IDE extension",
    },
  },
  conductor: {
    id: "conductor",
    slug: "switch-from-conductor",
    name: "Conductor",
    conversations:
      "Conductor runs Claude Code or Codex in its workspaces, so look in ~/.claude/projects/ and ~/.codex/sessions/ (or under $CLAUDE_CONFIG_DIR and $CODEX_HOME if they are set) for this folder's path.",
    keepsWorking: "Conductor keeps working while you try Omnyo.",
    setupStep: (
      <>
        Move Conductor's setup script into a <code>.omnyo-env-setup.sh</code> at
        the repo root, its Files to copy list into a{" "}
        <code>.worktreeinclude</code>, and commit both.
      </>
    ),
    chatImport: null,
  },
  cursor: {
    id: "cursor",
    slug: "switch-from-cursor",
    name: "Cursor",
    conversations:
      "Cursor keeps agent transcripts under ~/.cursor/projects/; look there for this project's agent-transcripts folder. Only read those files; never open Cursor's state.vscdb databases.",
    keepsWorking: "Cursor keeps working while you try Omnyo.",
    setupStep: (
      <>
        Move the setup commands from <code>.cursor/worktrees.json</code> into a{" "}
        <code>.omnyo-env-setup.sh</code> at the repo root, list files like{" "}
        <code>.env</code> in a <code>.worktreeinclude</code>, and commit both.
      </>
    ),
    chatImport: null,
  },
  superset: {
    id: "superset",
    slug: "switch-from-superset",
    name: "Superset",
    conversations:
      "Superset runs Claude Code or Codex in its worktrees, so look in ~/.claude/projects/ and ~/.codex/sessions/ (or under $CLAUDE_CONFIG_DIR and $CODEX_HOME if they are set) for this folder's path.",
    keepsWorking: "Superset keeps working while you try Omnyo.",
    setupStep: (
      <>
        Move the setup list from <code>.superset/config.json</code> into a{" "}
        <code>.omnyo-env-setup.sh</code> at the repo root, list files each
        worktree needs, like <code>.env</code>, in a{" "}
        <code>.worktreeinclude</code>, and commit both.
      </>
    ),
    chatImport: null,
  },
  "t3-code": {
    id: "t3-code",
    slug: "switch-from-t3-code",
    name: "T3 Code",
    conversations:
      "T3 Code runs Codex, Claude Code, or OpenCode, so look in ~/.codex/sessions/ and ~/.claude/projects/ (or under $CODEX_HOME and $CLAUDE_CONFIG_DIR if they are set), and in OpenCode's data folder, usually ~/.local/share/opencode/, for this folder's path.",
    keepsWorking: "T3 Code keeps working while you try Omnyo.",
    setupStep: (
      <>
        Move the scripts that run on worktree creation from <code>t3.json</code>{" "}
        into a <code>.omnyo-env-setup.sh</code> at the repo root, list files
        like <code>.env</code> in a <code>.worktreeinclude</code>, and commit
        both.
      </>
    ),
    chatImport: null,
  },
  "vibe-kanban": {
    id: "vibe-kanban",
    slug: "switch-from-vibe-kanban",
    name: "Vibe Kanban",
    conversations:
      "Vibe Kanban runs Claude Code or Codex in each attempt's worktree, so look in ~/.claude/projects/ and ~/.codex/sessions/ (or under $CLAUDE_CONFIG_DIR and $CODEX_HOME if they are set) for this folder's path.",
    keepsWorking:
      "Your local Vibe Kanban workspaces keep running while you try Omnyo.",
    setupStep: (
      <>
        Put Vibe Kanban's setup script in a <code>.omnyo-env-setup.sh</code> at
        the repo root, list files each worktree needs, like <code>.env</code>,
        in a <code>.worktreeinclude</code>, and commit both.
      </>
    ),
    chatImport: null,
  },
} satisfies Record<string, SwitchTool>;

const READ_STATE =
  "See where the work stands: git log, git status, and git diff against the base branch. If I named a pull request, read it and its comments with gh pr view <url> --comments.";

const FINISH = [
  "Write me a short handoff: the goal, what's done, the decisions made, and what's left. Wait for my OK.",
  "Continue with what's left. Don't change anything outside this folder, and don't push.",
];

function numbered(lines: string[]): string {
  return lines.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

export function switchPrompt(tool: SwitchTool): string {
  const from = tool.name;

  const readConversation = `Find the conversation where the task was being done, if there is one. ${tool.conversations} Pick the latest one for this folder or branch, skipping this conversation and any that only hit errors, and only read it.`;

  if (tool.chatImport === null) {
    return `Pick up a task I was working on in ${from}, in this folder, and keep going here. First, ask me which work I want to bring over, and suggest the latest conversation you find for this folder.

${numbered([READ_STATE, readConversation, ...FINISH])}`;
  }

  return `Pick up a task I was working on in ${from}, in this folder, and keep going here.

${numbered([
  `Look for the chat in Omnyo's Chat import first. Run omnyo chat-import scan --days 7 --json. If this folder is on a different machine from the Omnyo server, add --host with that machine's ID from omnyo machine list. List the chats with providerId ${tool.chatImport.providerId} whose cwd is this folder or inside it, newest first, and ask me which one to bring over. If it isn't there, ask me how far back to look and scan again with a larger --days, up to 365.`,
  "If the chat I pick has status ready, run omnyo chat-import run --chat <key> with its key and the same --days (and --host, if you used it) as the scan. Tell me the thread ID it prints and stop there: I'll open that thread, which continues the chat with its full history. If its status is already-imported or omnyo-chat, tell me its threadId and stop.",
  `If the chat can't be imported, or there's no chat for this task, catch up by hand. ${READ_STATE}`,
  readConversation,
  ...FINISH,
])}`;
}

const HANDOFF_SHOT: GuideShot = {
  src: "/guides/switch-to-omnyo/window-handoff.webp",
  alt: "The Pick up upload size limit thread in Omnyo: the agent asks whether the Claude Code conversation Reject uploads over 5 MB is the one to bring over, you answer Yes, that one, and after checking git and reading the old transcript it writes a handoff with the goal, what's done, the decisions, and what's left, ending Reply to correct anything, or say go",
  width: 2048,
  height: 1280,
};

function importStep(tool: SwitchTool, chatImport: ChatImport): GuideStep {
  return {
    id: "import",
    title: "Import your recent chats",
    lead: `Omnyo copies your recent ${tool.name} chats in, so each one carries on with its full history.`,
    body: (
      <>
        <Substeps>
          <li>
            In setup's <strong>Chats</strong> step, or later in{" "}
            <strong>Settings → Chat import</strong> (under Plugins), set how
            many days back to look. It starts at 2 days and goes up to 365.
          </li>
          <li>
            Untick any chats you don't want, then choose the{" "}
            <strong>Import</strong> button. Each chat lands in the project for
            its folder, and Omnyo names any new project before it creates it.
          </li>
          <li>
            Choose <strong>Open</strong> next to a chat and send a message. It
            continues where you left off, and your {tool.name} history stays as
            it was.
          </li>
        </Substeps>
        <p>
          Chat import reads chats from {chatImport.sources}. From a terminal,
          run <code>omnyo chat-import scan --days 7</code> to list them, then{" "}
          <code>omnyo chat-import run --days 7</code> to import every one that's
          ready.
        </p>
      </>
    ),
    shot: {
      src: "/guides/switch-to-omnyo/window-chat-import.webp",
      alt: "Omnyo's Chat import settings set to the last 7 days on MacBook Pro: 5 chats found, Claude Code 3 and Codex 2, four ticked for acme-web and a new acme-docs project, one unticked chat that isn't in a project folder, a New projects: acme-docs line, and an Import 4 chats button",
      width: 2048,
      height: 1280,
    },
    options: [],
  };
}

const IMPORT_TROUBLESHOOTING: GuideFaq = {
  question: "A chat isn't in the import list",
  answer: (
    <ol>
      <li>
        Chat import lists chats with a message in the last 2 days. Raise the
        number of days, up to 365.
      </li>
      <li>
        Scripted runs such as <code>codex exec</code>, subagent logs, and chats
        Omnyo ran are left out.
      </li>
      <li>
        A chat in your home folder, or in a folder that no longer exists, is
        listed with the reason it can't be imported. Start a thread in its
        folder and use the prompt from <strong>Copy for agent</strong> instead.
      </li>
    </ol>
  ),
};

export function switchGuide(meta: GuideMeta, tool: SwitchTool): Guide {
  const oldTool = tool.name;
  const chatImport = tool.chatImport;

  return {
    ...meta,
    description:
      chatImport === null
        ? `Pick up where ${oldTool} left off. Open the task where it was, and your agent reads the old conversation, tells you where things stand, and keeps going.`
        : `Pick up where ${oldTool} left off. Import your recent chats and keep going with their full history, or open the task where it was and let your agent catch up.`,
    heroTop: <SwitchConcept tool={tool.id} />,
    concept: null,
    agentPrompt: switchPrompt(tool),
    requirement: null,
    steps: [
      {
        id: "project",
        title: "Add your project",
        lead: "Omnyo finds the repos you've been working in.",
        body: (
          <Substeps>
            <li>
              Open Omnyo. In setup's <strong>Projects</strong> step, check the
              repos you work in, or choose{" "}
              <strong>Add a folder that isn't listed</strong>.
            </li>
            <li>
              Already set up? Choose <Ui icon="settings" /> at the bottom left,
              then <strong>Settings</strong>, or press ⌘,. Open{" "}
              <strong>Projects</strong> and choose{" "}
              <strong>Add a project</strong>.
            </li>
          </Substeps>
        ),
        shot: {
          src: "/guides/switch-to-omnyo/window-projects.webp",
          alt: "Omnyo's Settings → Projects page listing acme-web and acme-api with their GitHub remotes, machine counts, and thread counts, with the Add a project button at the top right",
          width: 2048,
          height: 1280,
        },
        options: [],
      },
      ...(chatImport === null ? [] : [importStep(tool, chatImport)]),
      {
        id: "thread",
        title: "Create a new thread",
        lead:
          chatImport === null
            ? `Start where ${oldTool} left off, so its branch and changes come along.`
            : `For work Chat import can't bring over, start where ${oldTool} left off, so its branch and changes come along.`,
        body: (
          <p>
            Choose <strong>New thread</strong> and pick the project. Then open
            the <strong>Start in</strong> menu (the branch chip, which shows{" "}
            <strong>main</strong>) and pick the folder {oldTool} worked in: its
            branch under <strong>Worktrees</strong>, or the main checkout at the
            top.
          </p>
        ),
        shot: {
          src: "/guides/switch-to-omnyo/window-existing-worktree.webp",
          alt: "Omnyo's new thread page for acme-web with the Start in menu open: the main checkout, New worktree from main, and a Worktrees list that includes feat/upload-size-limit, highlighted, and fix/login-redirect",
          width: 2048,
          height: 1280,
        },
        options: [],
      },
      {
        id: "prompt",
        title: "Paste the prompt",
        lead: null,
        body: (
          <Substeps>
            <li>
              Paste the prompt from <CopyPromptButton /> and send it.{" "}
              {chatImport === null
                ? "Your agent asks which work you want to bring over, then writes a handoff"
                : `Your agent lists your recent ${oldTool} chats for this folder and asks which one to bring over. If it can import that chat, it gives you the new thread to open. If it can't, it reads the old conversation and writes a handoff`}
              : the goal, what's done, and what's left. Reply to correct it, or
              say go.
            </li>
            <li>Do the same for each task you want to bring over.</li>
          </Substeps>
        ),
        shot: HANDOFF_SHOT,
        options: [],
      },
    ],
    troubleshooting: [
      {
        question: "I can't find my old folder",
        answer: (
          <ol>
            <li>
              Open the <strong>Start in</strong> menu.{" "}
              <strong>Worktrees</strong> lists the Git worktrees of the project
              you picked on the chosen machine; type in{" "}
              <strong>Search worktrees</strong> if the list is long. If it says
              there are no other worktrees, check the project and the machine.
            </li>
            <li>
              If the folder isn't a Git worktree of that repo, add it as a
              project in <strong>Settings → Projects</strong> with{" "}
              <strong>Add a project</strong>, and start the thread there.
            </li>
          </ol>
        ),
      },
      ...(chatImport === null ? [] : [IMPORT_TROUBLESHOOTING]),
      {
        question: "The agent couldn't find the old conversation",
        answer: (
          <ol>
            <li>
              Your agent looks for {oldTool}'s conversations on this computer.
              If they were deleted or ran elsewhere, there's nothing to read.
            </li>
            <li>
              It then works from the branch or pull request. Tell it what was
              left to do.
            </li>
          </ol>
        ),
      },
      {
        question: "A thread fails right away",
        answer: (
          <ol>
            <li>Its agent probably isn't signed in on this computer.</li>
            <li>
              Sign in to that agent once, then send the thread a message to
              start it again.
            </li>
          </ol>
        ),
      },
    ],
    faq: [
      {
        question: `Will Omnyo change anything in ${tool.name}?`,
        answer: (
          <p>
            No. Omnyo works in your worktrees where they are and doesn't move
            anything, and archiving an Omnyo thread never deletes a worktree
            Omnyo didn't create.
            {chatImport === null
              ? ""
              : ` Chat import only reads your ${tool.name} chats and never changes them.`}{" "}
            Bring over one task at a time, whenever you're ready.{" "}
            {tool.keepsWorking}
          </p>
        ),
      },
      {
        question: "What comes along?",
        answer: (
          <p>
            Your repos, branches, uncommitted changes, and open pull requests.
            Claude Code and Codex in Omnyo use the same CLAUDE.md, AGENTS.md,
            skills, MCP servers, and sign-ins they use now.{" "}
            {chatImport === null
              ? `Your old chats stay in ${oldTool}; each Omnyo thread reads the one it continues.`
              : `Chat import copies your recent chats into Omnyo, and each one continues with its full history. The originals stay as they are, so you can still continue them in ${oldTool}.`}
          </p>
        ),
      },
      {
        question: "Do my setup scripts come along?",
        answer: <p>{tool.setupStep}</p>,
      },
      {
        question: "Do my automations come along?",
        answer: (
          <p>
            Not on their own. Recreate each one in{" "}
            <a href="/guides/run-an-agent-on-a-schedule">Omnyo automations</a>:
            paste its schedule and prompt, and your agent sets it up.
          </p>
        ),
      },
      COST_FAQ,
      AGENTS_FAQ,
    ],
    closer: {
      title: "Get more done with the agents you already use",
      body: "Run more agents at once, see which one needs you, and let them hand work to each other. Free to use, on the agent subscriptions you already have.",
    },
  };
}
