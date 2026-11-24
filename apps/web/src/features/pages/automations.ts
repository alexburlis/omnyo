import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Put recurring agent work on a timer",
  lede: "Run a Claude Code or Codex prompt, or a script, on a schedule, and Omnyo tells you when a run fails.",
  sections: [
    {
      heading: "Schedule a prompt, pick where it runs",
      body: "Write what you would type into a chat, pick a cron schedule and timezone, and choose where each run goes: a new chat, an existing chat or a fresh worktree.",
      bullets: [
        "Schedules read as plain English in the panel",
        "Permission modes: accept edits, auto or full",
        "Run one now from the panel or `omnyo automation run`",
      ],
      visual: "automations-detail",
    },
    {
      heading: "Scripts check first and stay quiet",
      body: "A script automation runs bash, sh, node or python3 and keeps its output and exit code. When there is nothing to report, it prints nothing and the run is logged as Skipped.",
      bullets: [
        'Ending with `{"wakeAgent": false}` also counts as Skipped',
        "Default timeout 2 minutes, at most 1 hour",
      ],
      visual: "automations-script",
    },
    {
      heading: "A broken automation pauses itself",
      body: "A failed run retries after 30 seconds, then after 60, and a third failure in a row pauses the automation. Omnyo notifies you on the first failure and again when it pauses.",
      bullets: [
        "Temporary provider failures keep retrying and never pause it",
        "Resume it from the panel once it is fixed",
      ],
      visual: "automations-paused",
    },
  ],
  goodToKnow: [
    {
      label: "Runs on",
      value:
        "Your Omnyo server. Nothing starts while that computer is off or asleep.",
    },
    {
      label: "Missed runs",
      value: "Not replayed. An overdue schedule fires once, then carries on.",
    },
    {
      label: "Schedules",
      value:
        "Five-field cron with an IANA timezone, or a one-time date or delay such as `2h`.",
    },
    {
      label: "Limits",
      value: "One active run per automation at a time.",
    },
    {
      label: "CLI",
      value:
        "`omnyo automation` creates, lists, pauses, resumes and runs them, all with `--json`.",
    },
  ],
  faq: [
    {
      question: "Can I run Claude Code on a cron schedule?",
      answer:
        "Yes. An agent automation takes a five-field cron expression and a timezone, such as `0 9 * * 1-5` for weekdays at 9. Codex works the same way.",
    },
    {
      question: "Does my computer need to stay on?",
      answer:
        "The computer that runs your Omnyo server does. While it is off or asleep nothing runs, and missed runs are not replayed.",
    },
    {
      question: "Can a scheduled chat create more automations?",
      answer:
        "No. Chats that an automation starts cannot create automations of their own.",
    },
    {
      question: "When should I use a state machine instead?",
      answer:
        "When the trigger is not a clock, or the work has steps, choices and loops. [Waits](/features/goals-and-waits) wake one chat on an event; a [state machine](/features/state-machines) runs a whole workflow.",
    },
  ],
  relatedFeatures: ["state-machines", "goals-and-waits", "notifications"],
  relatedGuides: [
    {
      slug: "run-an-agent-on-a-schedule",
      label: "Run an agent on a schedule",
    },
  ],
};
