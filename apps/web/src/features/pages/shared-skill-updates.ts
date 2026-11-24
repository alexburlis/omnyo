import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "One shared folder. One file watch.",
  lede: "A preview of how Omnyo keeps command and skill lists current when several workspaces use the same folder on one machine.",
  sections: [
    {
      heading: "Edit a skill once",
      body: "Say your API and website projects share a code review skill. Change its description and both projects pick up the new wording. A project with its own skills folder skips the refresh.",
      bullets: [],
      visual: "shared-skill-updates",
    },
    {
      heading: "Let idle readers exit",
      body: "After a minute of inactivity, the process that reads a workspace’s commands and skills exits. The shared watch can still detect the next edit. When the last workspace stops using the folder, Omnyo releases the watch too.",
      bullets: [],
      visual: "skill-watch-counts",
    },
  ],
  goodToKnow: [],
  faq: [
    {
      question: "Do I need to turn this on?",
      answer:
        "The feature is automatic in the runtime that includes it. You can keep using your usual skills folders.",
    },
    {
      question: "Does this copy skills between projects?",
      answer:
        "Each workspace keeps its own configuration. Omnyo shares the file watch when workspaces already read skills from the same folder.",
    },
    {
      question: "How did you test it?",
      answer:
        "On a Mac, we opened two workspaces with a shared skills folder and a third with a separate folder. We counted one native watch on the shared folder. After the readers exited, another edit still refreshed both interested workspaces.",
    },
  ],
  relatedFeatures: ["parallel-agents", "performance"],
  relatedGuides: [],
};
