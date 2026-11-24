import { SpawnTimeline } from "../../compare/compare-visuals";
import { CopyPromptButton, PromptBlock, Substeps, Ui } from "../guide-blocks";
import { skillOffer, withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import {
  NESTED_SHOT,
  SPLIT_SHOT,
  TALK_SHOT,
  TEAM_FAQ,
  TEAM_TROUBLESHOOTING,
} from "../shared/agent-teams";
import { meta } from "./orchestrate-coding-agents.meta";

const AGENT_PROMPT = withIntake(
  [
    { label: "Task", hint: "what to build or fix" },
    {
      label: "Reviewer",
      hint: "a different agent from you",
    },
  ],
  `Build the task, have a different agent review it in its own thread, talk it through with the reviewer. One review round, then stop.
Guide: /guides/orchestrate-coding-agents

Do these steps in order and run each check. If a check fails, stop and tell me what you saw. Don't push, open a pull request, or merge unless I ask.

1. Get a branch. If you're on the repo's default branch, create a new branch first. Run \`BASE=$(git rev-parse HEAD)\` and keep the value.
   Check: \`git branch --show-current\` isn't the default branch.

2. Build the task and commit your work.
   Check: \`git status\` is clean and \`git log -1\` shows your commit.

3. Start the reviewer in its own thread, in this worktree. Use my Reviewer answer. By default, pick an agent other than you from omnyo provider list --environment "$OMNYO_ENVIRONMENT_ID".
   omnyo thread spawn --json --project "$OMNYO_PROJECT_ID" --environment "$OMNYO_ENVIRONMENT_ID" --parent-self --provider <provider-id> --title "Review: <task>" --prompt "Task: <task>. Review git diff <BASE>..HEAD read-only. Don't edit files or commit. List each issue as serious or minor, with file and line."
   Check: the spawn returns a thread ID. If the reviewer fails to start, stop and ask me to sign in to that agent on this computer.

4. Wait for the review and read it:
   omnyo thread wait <reviewer-thread-id> --timeout 60m
   omnyo thread output <reviewer-thread-id>
   Check: the output lists issues or says there are none. If Omnyo later tells you the reviewer finished, just repeat your final report.

5. Fix every serious issue and commit. If a finding is unclear, ask first: omnyo thread tell <reviewer-thread-id> --mode auto "<your question>", then read the answer with omnyo thread wait and omnyo thread output. Don't ask for a second review.
   Check: \`git status\` is clean and each serious issue has a fix.

6. Stop. Leave the reviewer's thread open so I can read it; don't archive it.

Reply with what you built, what the review found, what you fixed, and what's left for me. ${skillOffer("build-and-review", "my reviewer")}`,
);

export const guide: Guide = {
  ...meta,
  description:
    "Have one agent build and another review, keep a manager for work you repeat, or fan out big changes to many agents at once. You can step in at any time, or coordinate with just one.",
  heroTop: null,
  concept: <SpawnTimeline />,
  agentPrompt: AGENT_PROMPT,
  requirement: "two or more agents signed in, like Claude Code and Codex",
  steps: [
    {
      id: "step-1",
      title: "Start a thread with your task",
      lead: "Pick the agent you want building it. It writes the code, brings in a reviewer, and reports back to you.",
      body: (
        <Substeps>
          <li>
            Choose <strong>New thread</strong> and pick the agent, like Claude
            Code.
          </li>
          <li>
            Open the <strong>Start in</strong> menu (the <strong>main</strong>{" "}
            chip under the message box) and choose{" "}
            <strong>New worktree from main</strong>, so the work gets its own
            branch.
          </li>
          <li>
            Paste the prompt from <CopyPromptButton /> and send it. Your agent
            asks for your task and reviewer.
          </li>
        </Substeps>
      ),
      shot: {
        src: "/guides/orchestrate-coding-agents/window-start-interview.webp",
        alt: "Omnyo's new thread page for acme-web with Claude Code's Opus 5.5 Medium selected, the copied orchestration prompt pasted into the message box, and the Start in menu open with New worktree from main checked",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-2",
      title: "Get a second opinion from another agent",
      lead: "A different agent reads the change with fresh context and catches what the first one missed. You don't copy anything between them.",
      body: (
        <p>
          Once its work is committed, your agent starts the reviewer in a thread
          of its own, on the same branch, and nests it under itself in the
          sidebar. You can ask for any agent you have signed in by name, like
          “Have Codex review this” or “Ask Claude Code to write the release
          notes.”
        </p>
      ),
      shot: NESTED_SHOT,
      options: [],
    },
    {
      id: "step-3",
      title: "Watch them talk it through",
      lead: "The agents message each other the way you message them. Your agent hears back as soon as a review is done, and fixes what's serious.",
      body: (
        <>
          <Substeps>
            <li>
              In the sidebar, hover the reviewer, open its <Ui icon="more" />{" "}
              menu (or right-click it) and choose <strong>Open in split</strong>
              .
            </li>
            <li>Type in either thread to step in yourself.</li>
          </Substeps>
          <p>
            When the review is done, your agent's thread shows a row like{" "}
            <strong>Review: Rate-limit uploads finished</strong> with the
            findings, and your agent starts on the serious ones.
          </p>
        </>
      ),
      shot: SPLIT_SHOT,
      options: [
        {
          title: "Ask the reviewer a question through your agent",
          body: (
            <p>
              Ask your agent to check something with the reviewer, like “Ask the
              reviewer whether the memory growth is worth fixing before this
              merges.” It asks, waits for the answer, and tells you what it
              said.
            </p>
          ),
          shot: TALK_SHOT,
        },
      ],
    },
    {
      id: "step-4",
      title: "Keep a manager for work you repeat",
      lead: "A manager is a thread you keep for one job, like triaging new issues. Correct it once, and it does the job your way from then on.",
      body: (
        <>
          <Substeps>
            <li>
              Start a thread for the job. Then choose <strong>Rename</strong>{" "}
              from its <Ui icon="more" /> menu and name it after the job, like{" "}
              <strong>Issue triage</strong>.
            </li>
            <li>
              Walk it through the job once, like where new issues land and how
              you rank them, and correct it as you go.
            </li>
            <li>
              Ask it to save the job as a skill, a saved set of instructions it
              reuses.
            </li>
          </Substeps>
          <PromptBlock
            name="Ask the manager"
            prompt="Save how you triage issues as a skill called issue-triage in this repo. Run it every time I ask for triage, and update it whenever I correct you."
          />
        </>
      ),
      shot: {
        src: "/guides/orchestrate-coding-agents/window-manager.webp",
        alt: "The Issue triage thread in Omnyo: the agent re-ranks the issues after the user's rule that a deploy regression is always P0, then saves the job as an issue-triage skill in the repo",
        width: 2048,
        height: 1280,
      },
      options: [
        {
          title: "Hand it a thread that's already started",
          body: (
            <p>
              Ask the manager to nest the thread under its own and take the next
              step, like “Nest the Fix emoji filenames thread under you, then
              open a pull request for it and watch CI.” It doesn't have to be
              the agent that did the work.
            </p>
          ),
          shot: {
            src: "/guides/orchestrate-coding-agents/window-adopt.webp",
            alt: "The Issue triage manager after you ask it to take over Fix emoji filenames: a Fix emoji filenames assigned to you row, its reply that it opened #215 and CI passed, and Fix emoji filenames nested under Issue triage in the sidebar",
            width: 2048,
            height: 1280,
          },
        },
      ],
    },
    {
      id: "step-5",
      title: "Wake it every morning",
      lead: "An automation messages the manager on a schedule, so every run lands in the same thread and builds on the last.",
      body: (
        <>
          <p>Ask the manager to schedule itself.</p>
          <PromptBlock
            name="Ask the manager"
            prompt="Every weekday at 9am my time, have an automation message this thread and ask you to run your issue-triage skill. Run it once now to test it."
          />
          <p>
            Open <strong>Automations</strong> to see its schedule and runs, or
            switch it off.{" "}
            <a href="/guides/run-an-agent-on-a-schedule">
              Run an agent on a schedule
            </a>{" "}
            covers testing a run and notifications.
          </p>
        </>
      ),
      shot: {
        src: "/guides/orchestrate-coding-agents/window-automation.webp",
        alt: "The Morning issue triage automation in Omnyo, switched on for 9AM Mon-Fri with its next run on Nov 16 at 9:00 AM, a prompt that runs the issue-triage skill, an Existing thread chip, and one successful run",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-6",
      title: "Fan out a big change with a workflow",
      lead: "For a big, repetitive change, like fixing one lint rule across a whole codebase, a workflow starts a worker for each part of the job and checks the results.",
      body: (
        <>
          <p>
            Ask your agent for a workflow by name. <strong>Workflows</strong> is
            on by default. If you turned it off, choose the gear{" "}
            <Ui icon="settings" /> at the bottom left, then{" "}
            <strong>Settings</strong> (or press ⌘,), open{" "}
            <strong>Installed plugins</strong> and switch it back on.
          </p>
          <PromptBlock
            name="Example"
            prompt="Use a workflow to fix every no-floating-promises lint error. Start one Codex worker per folder in src, then have a Claude Code worker check each folder's fixes. Open one PR when every check passes."
          />
          <p>
            The run shows in the thread with each worker's progress. To stop it,
            open the run in the side panel from its card above the message box,
            and choose <strong>Stop workflow</strong>.
          </p>
        </>
      ),
      shot: {
        src: "/guides/orchestrate-coding-agents/window-workflows.webp",
        alt: "The Fix no-floating-promises thread running a workflow: its card in the thread and the run in the side panel show the Fix phase with three Codex workers, one done and two running, Check not started, and a Stop workflow button",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
  ],
  troubleshooting: [
    ...TEAM_TROUBLESHOOTING,
    {
      question: "My manager forgot a correction",
      answer: (
        <ol>
          <li>
            Long threads get compacted, and older details can drop out of the
            conversation.
          </li>
          <li>
            Ask the manager to add the correction to its skill, so it holds on
            every run.
          </li>
        </ol>
      ),
    },
    {
      question: "My manager didn't run this morning",
      answer: (
        <p>
          See “My automation didn't run” in{" "}
          <a href="/guides/run-an-agent-on-a-schedule">
            Run an agent on a schedule
          </a>
          .
        </p>
      ),
    },
    {
      question: "My agent won't start a workflow",
      answer: (
        <ol>
          <li>
            Check that <strong>Workflows</strong> is on in{" "}
            <Ui icon="settings">Settings → Installed plugins</Ui>. It's on
            unless you turned it off.
          </li>
          <li>
            Ask for a workflow by name. Agents don't start one unless you ask.
          </li>
        </ol>
      ),
    },
  ],
  faq: [
    ...TEAM_FAQ,
    {
      question: "What's the difference between a manager and a workflow?",
      answer: (
        <p>
          A manager is one thread you keep for a job and talk to over days. A
          workflow is a single run that splits one big job across many workers
          and finishes.
        </p>
      ),
    },
  ],
  closer: {
    title: "Hand off the work you repeat",
    body: "Free to use. Bring the Claude and ChatGPT plans you already have.",
  },
};
