import { Ui } from "../guide-blocks";
import type { GuideFaq, GuideShot } from "../guide-types";
import { AGENTS_FAQ, COST_FAQ, SLEEP_TROUBLESHOOTING } from "./faq";

export const NESTED_SHOT: GuideShot = {
  src: "/guides/claude-code-and-codex-together/window-nested.webp",
  alt: "The Claude Code thread Rate-limit uploads in acme-web after it committed its change and started a read-only Codex review, with the Codex thread Review: Rate-limit uploads running nested under it in the sidebar",
  width: 2048,
  height: 1280,
};

export const SPLIT_SHOT: GuideShot = {
  src: "/guides/claude-code-and-codex-together/window-split-oneround.webp",
  alt: "Split view: on the left, the Claude Code thread Rate-limit uploads shows a Review: Rate-limit uploads finished row, then edits two files and commits a fix for the serious finding; on the right, the Codex reviewer lists one serious finding, that the limit is keyed on the socket IP, and two minor ones",
  width: 2048,
  height: 1280,
};

export const TALK_SHOT: GuideShot = {
  src: "/guides/claude-code-and-codex-together/window-talk.webp",
  alt: "The Claude Code thread Rate-limit uploads after you ask it to check with the reviewer: a Sent to Review: Rate-limit uploads card with the question about the bucket map's memory growth, a second Review: Rate-limit uploads finished row, and its summary that the fix can wait until before launch",
  width: 2048,
  height: 1280,
};

export const TEAM_TROUBLESHOOTING: [GuideFaq, ...GuideFaq[]] = [
  {
    question: "My agent didn't bring in a reviewer",
    answer: (
      <ol>
        <li>
          Your agent starts other threads when you ask it to. Check that the
          prompt from <strong>Copy for agent</strong> is in your first message.
        </li>
        <li>
          Or ask directly, naming the agent and the job, like “Have Codex review
          this branch, read-only.”
        </li>
      </ol>
    ),
  },
  {
    question: "The reviewer's thread failed right away",
    answer: (
      <ol>
        <li>Open the reviewer's thread and read the error.</li>
        <li>
          Usually that agent isn't signed in on this computer. Sign in to it
          once, like <code>codex login</code> for Codex.
        </li>
        <li>Send the reviewer's thread a message to start it again.</li>
      </ol>
    ),
  },
  {
    question: "My agent never heard back from the reviewer",
    answer: (
      <ol>
        <li>
          Check the sidebar. Your agent only hears from threads nested under its
          own.
        </li>
        <li>
          If the reviewer sits on its own, ask your agent to nest it under its
          own thread.
        </li>
        <li>
          Then tell your agent the review is ready, so it reads it now instead
          of waiting.
        </li>
      </ol>
    ),
  },
  {
    question: "The reviewer is stuck waiting",
    answer: (
      <ol>
        <li>
          Its questions go to your agent's thread, not to you. Your agent
          answers them, or asks you when only you can decide.
        </li>
        <li>
          If it's waiting for permission to run something, open its thread and
          approve or deny it. Your agent is told it's waiting.
        </li>
      </ol>
    ),
  },
  {
    question: "Both agents changed the same files",
    answer: (
      <ol>
        <li>
          They share one worktree, so they share files. Tell the reviewer to
          stay read-only, as the prompt from <strong>Copy for agent</strong>{" "}
          does.
        </li>
        <li>
          If both need to write, have them take turns, or ask for the second
          agent in its own worktree.
        </li>
      </ol>
    ),
  },
  {
    question: "The reviewer can't see the changes",
    answer: (
      <ol>
        <li>
          It started in a separate worktree, so it can't see work that isn't
          committed.
        </li>
        <li>
          Ask your agent to commit, then start the reviewer in this same
          worktree, as the prompt from <strong>Copy for agent</strong> does.
        </li>
      </ol>
    ),
  },
  {
    question: "The reviewer's thread disappeared",
    answer: (
      <p>
        If it was archived, open{" "}
        <Ui icon="settings">Settings → Archived threads</Ui> and choose{" "}
        <strong>Unarchive</strong>.
      </p>
    ),
  },
  SLEEP_TROUBLESHOOTING,
];

export const TEAM_FAQ: GuideFaq[] = [
  {
    question: "When is a second agent worth it?",
    answer: (
      <>
        <p>For most changes, one agent does fine. A second one pays off for:</p>
        <ul>
          <li>
            <strong>Review.</strong> An agent on another model reads the change
            with fresh eyes.
          </li>
          <li>
            <strong>Plan, then hand off.</strong> Have your strongest model
            interview you and write the plan, then hand the build to a faster,
            cheaper one.
          </li>
        </ul>
      </>
    ),
  },
  AGENTS_FAQ,
  {
    question: "How do agents reach each other?",
    answer: (
      <p>
        Every thread comes with Omnyo's tools and a short guide to them, so an
        agent can start, wait for, and message other threads the way you would.
        A message reaches a busy agent mid-turn, and one sent to an agent that's
        waiting on a question is delivered once you answer.
      </p>
    ),
  },
  {
    question: "Can I step in?",
    answer: (
      <p>
        Yes. Type in either thread at any time, or stop one from its message
        box. A stopped thread keeps its history and worktree. Omnyo doesn't tell
        the other agent you stopped it, so let it know.
      </p>
    ),
  },
  COST_FAQ,
];
