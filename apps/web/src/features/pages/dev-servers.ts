import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "A dev server for every branch",
  lede: "Your agent registers each dev server once, and Omnyo shows whether it is up and restarts it on its own machine with one click.",
  sections: [
    {
      heading: "Restart it from the chat box",
      body: "The chat's servers sit above the composer with their address, status and machine. Restart runs the saved command on that machine, and a Started step appears in the chat.",
      bullets: [
        "Never kills whatever holds the port, never moves ports",
        "Port in use: another program holds the port",
        "Computer offline: restart once the machine reconnects",
      ],
      visual: "dev-servers-restart",
    },
    {
      heading: "Open it on your phone",
      body: "On another device, Omnyo turns the localhost link into a private preview link on your Omnyo server, and live reload keeps working. On a phone, the server button in the chat header lists them.",
      bullets: [
        "Open works while the server is Running",
        "Restart runs its saved command again",
      ],
      visual: "dev-servers-phone",
    },
  ],
  goodToKnow: [
    {
      label: "Setup",
      value:
        "Omnyo never scans for servers. The agent registers the exact command, folder and URL.",
    },
    {
      label: "Worktrees",
      value:
        "A chat in its own worktree gets its own servers, so branches run side by side.",
    },
    {
      label: "Ports",
      value:
        "Omnyo does not pick ports. A committed `.omnyo-env-setup.sh` can write free ones per worktree.",
    },
    {
      label: "Sign-in",
      value:
        "Previews refuse redirects off the registered server, so external sign-in flows fail there.",
    },
    {
      label: "CLI",
      value:
        "`omnyo preview` registers, lists, checks, restarts and removes servers, all with `--json`.",
    },
  ],
  faq: [
    {
      question: "Does Omnyo find my dev servers automatically?",
      answer:
        "No. The agent registers each server once with `omnyo preview register`, giving the command, folder and URL. After that, Omnyo can check and restart it.",
    },
    {
      question: "What if another process is already on the port?",
      answer:
        "The server shows Port in use and Omnyo leaves that program alone. Stop it yourself, then restart the server on its saved port.",
    },
    {
      question: "Can I reach a preview from another network?",
      answer:
        "Yes, through [Omnyo connect](/features/mobile-remote-control) with a free account, or your own Tailscale network.",
    },
  ],
  relatedFeatures: ["parallel-agents", "browser", "mobile-remote-control"],
  relatedGuides: [
    {
      slug: "remote-dev-servers",
      label: "Run a dev server for every branch",
    },
  ],
};
