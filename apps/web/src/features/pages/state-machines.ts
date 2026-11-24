import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Agent loops with a limit on every step",
  lede: "Draw a workflow of waits, agent runs, commands and approvals that can loop, with a deadline and attempt limit on every step.",
  sections: [
    {
      heading: "Every step runs within its limits",
      body: "An agent step picks a provider, model and permission mode, and a command step runs without a shell and names its success exit codes. Active work shows each step's attempt and deadline.",
      bullets: [
        "Deadlines up to 2 hours, up to 3 attempts per step",
        "Pause now, pause after the current step, resume or stop",
        "Waits wake on an event, or poll every 30 s or more",
      ],
      visual: "state-machines-work",
    },
    {
      heading: "A person decides when it matters",
      body: "A manual state asks you how to continue, and a choice can require a reason. Runs waiting on you collect under Needs you, above your list of machines.",
      bullets: [
        "Up to 32 decisions per manual state",
        "An unclear outcome is never retried by itself",
      ],
      visual: "state-machines-decision",
    },
  ],
  goodToKnow: [
    {
      label: "Start from",
      value:
        "A blank machine, the Local check loop or the Release loop template.",
    },
    {
      label: "Size",
      value: "Up to 100 states and 300 transitions per machine.",
    },
    {
      label: "Runaway guard",
      value:
        "By default 32 instant steps per wake and 10 action starts per five minutes.",
    },
    {
      label: "Edits",
      value:
        "A running instance keeps the version it started on. Your edits change the draft.",
    },
    {
      label: "Events",
      value:
        "No built-in webhooks. Send events from the CLI or SDK, or from a source you connect.",
    },
    {
      label: "Windows",
      value: "Command steps are refused on Windows hosts.",
    },
  ],
  faq: [
    {
      question: "Can a state machine loop forever?",
      answer:
        "The graph can loop as long as you like, but each agent or command step has its own deadline and attempt limit, and runaway guards stop a machine that spins without waiting.",
    },
    {
      question: "What happens when Omnyo restarts?",
      answer:
        "Run state, timers and history live in the plugin's own database. Nothing runs while Omnyo is stopped, and stored deadlines and subscriptions are reconciled when it starts again.",
    },
    {
      question: "How is this different from an automation?",
      answer:
        "An [automation](/features/automations) runs one prompt or script on a schedule. A state machine chains waits, agent steps, commands and approvals into a graph that can branch and loop.",
    },
    {
      question: "What permission mode do agent steps use?",
      answer:
        "Full by default, and you can choose accept-edits or auto per step. Effect labels on a step describe what it touches; they are not an operating-system sandbox.",
    },
  ],
  relatedFeatures: ["automations", "goals-and-waits", "multi-agent"],
  relatedGuides: [
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
  ],
};
