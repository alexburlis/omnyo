import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Bring your chats from Claude Code, Codex and more",
  lede: "Import recent chats from Claude Code, Codex, Pi, Cursor, opencode, Grok Build and Hermes Agent in one click. Omnyo only reads your history.",
  sections: [
    {
      heading: "Keep going with the full context",
      body: "Chats from all seven agents continue with the agent that started them. Your first message forks the native session, so the agent keeps everything it knew and the original stays as it was. Very long chats show only their newest turns.",
      bullets: [],
      visual: "chat-import-fork",
    },
    {
      heading: "Script it from the command line",
      body: "`omnyo chat-import scan` lists what can come across and why the rest cannot. `omnyo chat-import run` imports the ready chats; running it twice is safe.",
      bullets: [
        "`--days` sets the window, from 1 to 365 days",
        "`--host` imports from another of your machines",
      ],
      visual: "chat-import-cli",
    },
    {
      heading: "Coming from Conductor or Superset",
      body: "Conductor, Superset, T3 Code and Vibe Kanban get a switch guide instead. Paste its prompt into a new chat in the same folder, and the agent writes a handoff that carries the work over.",
      bullets: [],
      visual: "chat-import-handoff",
    },
  ],
  goodToKnow: [
    {
      label: "Agents",
      value:
        "Claude Code, Codex, Pi, Cursor, opencode, Grok Build and Hermes Agent.",
    },
    {
      label: "Reads",
      value:
        "Each agent's own history, such as `~/.claude` and `~/.codex` for Claude Code and Codex.",
    },
    {
      label: "Window",
      value: "Chats from the last 2 days by default, up to 365.",
    },
    {
      label: "Projects",
      value:
        "A chat outside any project creates one at its folder's Git top level.",
    },
    {
      label: "Not imported",
      value:
        "Settings, automations, setup scripts, credentials, scripted runs and subagent logs.",
    },
    {
      label: "Limit",
      value:
        "Imported Codex chats cannot continue while Account Pooler routes Codex.",
    },
  ],
  faq: [
    {
      question: "Does importing change my original history?",
      answer:
        "No. Omnyo only reads each agent's chat files, such as those under `~/.claude` and `~/.codex`. Your first message forks the session, so the original stays as it was.",
    },
    {
      question: "How do I resume a Claude Code session in Omnyo?",
      answer:
        "Import it, open the chat and send a message. The agent continues with the full context of the earlier conversation.",
    },
    {
      question: "Why can't some chats be imported?",
      answer:
        "Each one shows its reason, such as a folder that no longer exists or a chat started in your home folder. Chats Omnyo ran itself are already in Omnyo.",
    },
    {
      question: "Can I import chats from Conductor or Superset?",
      answer:
        "Not with the importer. Their switch guides have the agent write a handoff instead; start with the [Conductor guide](/guides/switch-from-conductor).",
    },
  ],
  relatedFeatures: ["claude-code-gui", "codex-gui", "inbox"],
  relatedGuides: [
    {
      slug: "switch-from-claude-code",
      label: "From Claude Code",
    },
    {
      slug: "switch-from-codex",
      label: "From Codex",
    },
  ],
};
