import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "All your computers, working as one Omnyo",
  lede: "Pick any Mac, Windows or Linux computer to host the Omnyo server. Your other computers join it and run agents too, and your phone or any browser steers every chat.",
  sections: [
    {
      heading: "Any computer can be the server",
      body: "The server is a role, not a special box. It keeps your chats, the database and your settings, and it runs agents like every other computer. A laptop works while it is awake. A Mac mini, a desktop, a home server or a VM can stay on all day. Settings → Machines marks the one you chose with a server badge.",
      bullets: [
        "Server: macOS, Linux, Windows through WSL2, or Windows 11 natively in alpha.",
        "Machines that run agents: any other Mac, Windows or Linux computer you add.",
        "Screens: the desktop app, the iPhone app or any browser. They run nothing themselves, so closing one leaves your agents running.",
      ],
      visual: "devices-machines",
    },
    {
      heading: "Add a computer with one command",
      body: "In Settings → Machines, choose Add a machine. Omnyo shows a setup code and a one-line command: a shell command for macOS and Linux, or a PowerShell command for Windows. Run it on the new computer and it appears in your list as soon as it connects.",
      bullets: [
        "It installs the host-only `omnyo-app` package from your own server: the daemon, the agent workers and the `omnyo` CLI, with no web app and no server.",
        "The installer checks the package's SHA-256 digest and needs no sudo.",
        "A launchd or systemd service keeps the machine connected. On Windows it starts when you sign in.",
        "Each machine updates itself from your server, checks the digest again and never downgrades.",
      ],
      visual: "devices-join",
    },
    {
      heading: "Pick how your devices reach the server",
      body: "Machines, phones and browsers all connect to the server, and you choose the route. The install command carries it, so a new machine connects the same way as the rest.",
      bullets: [
        "Omnyo connect gives your server an address such as `https://you.omnyo.link` through Omnyo's relay, with a free account. The relay terminates TLS, so traffic through it is not end-to-end encrypted.",
        "Tailscale Serve keeps traffic on your own tailnet, and Tailscale's access rules decide who gets in.",
        "On a network you trust, `omnyo-app --server-bind-host 0.0.0.0` opens the server to the LAN. That API has no sign-in, so never expose it to the internet.",
        "Pair the iPhone app with a code from Settings → Mobile, and switch the desktop app between servers from its Server menu.",
      ],
      visual: "devices-routes",
    },
    {
      heading: "Each chat runs on the machine you pick",
      body: "When you start a chat, you pick the machine it runs on. The agent, the repository checkout, its worktrees and every command run there, with the Claude Code or Codex sign-in on that machine. The server keeps the chat history and streams it to every screen.",
      bullets: [
        "Settings → Machines sets the default machine for new chats, and `omnyo thread spawn --machine <name>` picks one from the command line.",
        "Each machine runs one chat per processor by default. Extra chats wait and start when a slot frees up.",
        "Turn on overflow and a waiting new chat can start on another machine that has room and meets the project's needs, such as macOS, Xcode or an NVIDIA GPU.",
      ],
      visual: "devices-run",
    },
  ],
  goodToKnow: [
    {
      label: "Stay on",
      value:
        "The server must stay on. While it sleeps or is off, nothing can reach Omnyo and running chats may stop.",
    },
    {
      label: "Windows",
      value:
        "A Windows machine needs Node.js 22.19 or later and Git for Windows. Hosting the server natively on Windows is in alpha.",
    },
    {
      label: "Linux",
      value:
        "Linux runs from the command line: `omnyo-app` starts a server, and the install command adds the computer as a machine.",
    },
    {
      label: "Many servers",
      value:
        "One computer can run agents for several Omnyo servers at once, with a separate daemon, data directory and service for each.",
    },
  ],
  faq: [
    {
      question: "Does the server have to be a Mac mini or a dedicated box?",
      answer:
        "No. Any Mac or Linux computer can host it, and so can a Windows 11 PC in alpha. The server runs agents too. Pick a computer that stays on while you are away from it, or keep a dedicated box or VM if you prefer.",
    },
    {
      question: "Can I change which computer is the server later?",
      answer:
        "Moving the server is an opt-in experiment for now. Turn it on with `omnyo settings experiment serverMove true`, then choose Move server here on another Mac or Linux machine in Settings → Machines. It copies your chats, settings and plugins, and the old computer keeps working as a regular machine.",
    },
    {
      question: "Can my phone run agents?",
      answer:
        "No. The phone app is a screen for your Omnyo server and runs nothing itself. Agents run on the computers you have connected.",
    },
    {
      question: "What happens if my server computer goes to sleep?",
      answer:
        "Nothing can reach Omnyo while the server is asleep or off, and running chats may stop. Pick a computer that stays on, such as a desktop, a home server or a VM.",
    },
    {
      question: "Do I need an account to use several devices?",
      answer:
        "Omnyo needs no account on your own machines. Omnyo connect needs a free account, and Tailscale is the alternative that keeps traffic on your own network.",
    },
  ],
  relatedFeatures: ["mobile-remote-control", "dev-servers", "privacy"],
  relatedGuides: [
    {
      slug: "work-from-anywhere",
      label: "Work from anywhere",
    },
    {
      slug: "remote-dev-servers",
      label: "Dev servers for every branch",
    },
  ],
};
