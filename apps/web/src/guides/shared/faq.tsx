import { Ui } from "../guide-blocks";
import type { GuideFaq } from "../guide-types";

export const AGENTS_FAQ: GuideFaq = {
  question: "Which agents work?",
  answer: (
    <p>
      Claude Code and Codex work out of the box. Pi, and Cursor, opencode, Grok
      Build, Hermes Agent and other agents that support the Agent Client
      Protocol, work once you install the agent and turn on its plugin (
      <strong>Pi provider</strong> or <strong>ACP providers</strong>) in{" "}
      <strong>Settings → Installed plugins</strong>.
    </p>
  ),
};

export const COST_FAQ: GuideFaq = {
  question: "Does it cost anything? Can I keep my plan?",
  answer: (
    <p>
      Omnyo is free to use, and there's no Omnyo subscription. It runs your
      agents on the subscriptions or API keys you already have. Machines you add
      cost what they do now.
    </p>
  ),
};

export const LINK_ACCESS_FAQ: GuideFaq = {
  question: "Who can open my omnyo.link links?",
  answer: (
    <p>
      Only you, signed in to your omnyo.link account, and devices you've paired.
      They aren't public, so webhooks and other services can't call them. To
      shut off access, open <Ui icon="settings">Settings → Omnyo connect</Ui>{" "}
      and choose <strong>Turn off</strong>, or choose{" "}
      <strong>Disconnect</strong> on that Omnyo in your omnyo.link dashboard.
    </p>
  ),
};

export const SLEEP_TROUBLESHOOTING: GuideFaq = {
  question: "My agents stopped while my computer slept",
  answer: (
    <ol>
      <li>
        Once the computer is back, open the thread and send a message to pick up
        where it left off.
      </li>
      <li>
        To keep it awake, open <Ui icon="settings">Settings</Ui>, choose{" "}
        <strong>Keep Awake</strong> under <strong>Plugins</strong>, and turn on{" "}
        <strong>Prevent idle sleep</strong>. It works on macOS and Windows.
      </li>
      <li>
        Closing a laptop's lid still puts it to sleep. For agents that run all
        day, run Omnyo on a computer that stays on.
      </li>
    </ol>
  ),
};

export const MACHINE_DISCONNECTED_TROUBLESHOOTING: GuideFaq = {
  question: "A machine shows as offline",
  answer: (
    <ol>
      <li>Check that its computer is on, awake, and online.</li>
      <li>
        In <Ui icon="settings">Settings → Machines</Ui>, open its{" "}
        <strong>⋯</strong> menu and choose <strong>Reconnect</strong>.
      </li>
      <li>
        Run the command it shows on that machine. Its threads and worktrees are
        kept.
      </li>
    </ol>
  ),
};
