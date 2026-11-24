import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Agents that follow through on their own",
  lede: "Give a chat a goal that a separate judge checks after every turn, or let it wait for another chat, a time or a URL and wake up by itself.",
  sections: [
    {
      heading: "A judge decides when the goal is met",
      body: "Start one with `omnyo pursue goal`. After each turn, a hidden judge chat inspects the workspace read-only and answers MET or UNMET, and an unmet verdict tells the worker what is still missing.",
      bullets: [
        "Stops after 12 checks by default, with a report",
        "The Goal pill shows the count and the last check",
      ],
      visual: "goals-and-waits-judge",
    },
    {
      heading: "Loops re-check until something changes",
      body: "`omnyo pursue loop` wakes the chat with a prompt at an interval of 30 seconds or more. Each quiet check doubles the wait, up to a day, and the Glance card shows the next one.",
      bullets: ["Omnyo's server owns the timer, so loops survive restarts"],
      visual: "goals-and-waits-loop",
    },
    {
      heading: "Outside checks wait for your OK",
      body: "An agent's wait on a URL or a shell command is only a proposal until you accept it in the Inbox, which shows the exact URL or command.",
      bullets: [
        "URLs and files are checked every minute",
        "Commands every two minutes, stopped after 20 seconds",
      ],
      visual: "goals-and-waits-approve",
    },
  ],
  goodToKnow: [
    {
      label: "Wait on",
      value:
        "Another chat, a time, a URL, a file, a shell command, a machine or an automation run.",
    },
    {
      label: "Agents",
      value: "Goals and loops work on Claude Code, Codex, Pi and ACP chats.",
    },
    {
      label: "Limits",
      value:
        "A wait without a deadline ends after 7 days. Goals stop at their check budget.",
    },
    {
      label: "CLI",
      value:
        "`omnyo wait sources` lists every wait type and its health; `omnyo wait check` tries one once.",
    },
    {
      label: "Not built in",
      value: "Waiting on GitHub pull requests or CI checks.",
    },
  ],
  faq: [
    {
      question: "Does the agent grade its own work?",
      answer:
        "No. A separate hidden judge chat inspects the workspace read-only and answers MET or UNMET. A judge can still be wrong, so a met goal is a strong signal, not a guarantee.",
    },
    {
      question: "Can an agent poll a URL or run a command without asking me?",
      answer:
        "No. An agent's wait on a URL or a command stays a proposal until you accept it in the Inbox.",
    },
    {
      question: "How is this different from Automations?",
      answer:
        "Goals and waits act on a chat that already exists. [Automations](/features/automations) start new runs once or on a schedule, and [State Machines](/features/state-machines) run a graph of steps.",
    },
  ],
  relatedFeatures: ["state-machines", "automations", "multi-agent"],
  relatedGuides: [
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
  ],
};
