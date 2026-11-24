import { AnywhereConcept } from "../concepts";
import { Substeps, Ui } from "../guide-blocks";
import { withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import {
  COST_FAQ,
  LINK_ACCESS_FAQ,
  MACHINE_DISCONNECTED_TROUBLESHOOTING,
  SLEEP_TROUBLESHOOTING,
} from "../shared/faq";
import { meta } from "./work-from-anywhere.meta";

const AGENT_PROMPT = withIntake(
  [
    { label: "Phone", hint: "iPhone or Android" },
    { label: "Notifications", hint: "yes or no" },
    { label: "Keep this computer awake", hint: "yes or no" },
  ],
  `Get this Omnyo ready for me to use from my phone.

Do these steps in order and run each check. If a check fails, stop and tell me what you saw. Don't change any other settings.

1. Run \`omnyo account status\`.
   Check: this Omnyo is signed in to an Omnyo account on omnyo.link. If it isn't, run \`omnyo account login\` and send me the link and code it prints. Ask me to open the link, choose Continue with GitHub, check that the code matches, pick my address and choose Claim, then choose Create and connect. Wait until I say "done", then run \`omnyo account status\` again.

2. Run \`omnyo connect status\`.
   Check: it shows my https://<handle>.omnyo.link address and "connected". If it says remote access is off, run \`omnyo connect on\` and check again.

3. Only if "Keep this computer awake" is yes: run \`omnyo keep-awake enable\`, then \`omnyo keep-awake status\`.
   Check: it says Enabled. If the keep-awake command isn't found, run \`omnyo plugin enable keep-awake\` and try again.

4. Set up the phone. Tell me what to do, then wait until I say "done".
   - iPhone with the Omnyo app: open Settings → Mobile in Omnyo on this computer and choose Add mobile device. In the app, choose Connect with Omnyo connect (if a server is already saved, open Servers and choose Add server first), then scan the QR code, or type the pairing code and choose Pair.
   - Android, or an iPhone without the app: open my omnyo.link address in the phone's browser and sign in with the same GitHub account.
   - Only if "Notifications" is yes and I use the iPhone app: in the app, open Settings → Servers and phone settings → Notifications, turn on Push notifications for this server, and allow them when the phone asks. Then run \`omnyo push-notifications list\`.
   Check: my phone shows my Omnyo projects and threads. With notifications, my phone is in the push-notifications list.

Reply with my omnyo.link address, whether my phone is connected, and whether Keep Awake is on. Remind me that closing a laptop's lid still puts it to sleep.`,
);

export const guide: Guide = {
  ...meta,
  description:
    "Your agents keep running on your computer while you're out. Check in, answer them, and start new work from your phone or any browser.",
  heroTop: null,
  concept: <AnywhereConcept />,
  agentPrompt: AGENT_PROMPT,
  requirement:
    "a free Omnyo account for Omnyo connect, and a phone with a web browser",
  steps: [
    {
      id: "step-1",
      title: "Turn on Omnyo connect",
      lead: "Sign in with a free Omnyo account, and your Omnyo gets a private omnyo.link address you can open from any device.",
      body: (
        <>
          <Substeps>
            <li>
              Choose the gear <Ui icon="settings" /> at the bottom left, then{" "}
              <strong>Settings</strong> (or press ⌘,). Under{" "}
              <strong>Plugins</strong>, choose <strong>Omnyo connect</strong>.
            </li>
            <li>
              Choose <strong>Sign in to your Omnyo account</strong>, then{" "}
              <strong>Open omnyo.link</strong>.
            </li>
            <li>
              On omnyo.link, choose <strong>Continue with GitHub</strong> and
              check that the code matches the one Omnyo shows. Pick your address
              and choose <strong>Claim</strong>, then{" "}
              <strong>Create and connect</strong>.
            </li>
            <li>
              Back in Omnyo, wait for <strong>Connected</strong> and your
              address. If it says <strong>Remote access is off</strong>, choose{" "}
              <strong>Turn on</strong>.
            </li>
          </Substeps>
          <p>
            Only your account can open that address, and your code and data stay
            on your computer. Got a connect code from your omnyo.link dashboard
            instead? Choose <strong>Have a pairing code?</strong> and enter it.
          </p>
        </>
      ),
      shot: {
        src: "/guides/work-from-anywhere/window-connect.webp",
        alt: "Omnyo connect in Omnyo's settings, signed out, with Remote access on, a Sign in to your Omnyo account button, and a Have a pairing code? button",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-2",
      title: "Keep your computer awake",
      lead: "Your agents keep working while you're away from the desk.",
      body: (
        <>
          <Substeps>
            <li>
              In <Ui icon="settings">Settings</Ui>, under{" "}
              <strong>Plugins</strong>, choose <strong>Keep Awake</strong>.
            </li>
            <li>
              Turn on <strong>Prevent idle sleep</strong>. Keep{" "}
              <strong>All hosts</strong>, or choose{" "}
              <strong>Specific hosts</strong> for the computers that run your
              agents.
            </li>
          </Substeps>
          <p>
            Closing a laptop's lid still puts it to sleep. For agents that never
            stop, run Omnyo on a desktop or mini PC that stays on.
          </p>
        </>
      ),
      shot: {
        src: "/guides/work-from-anywhere/window-keep-awake.webp",
        alt: "Keep Awake in Omnyo's settings, with Prevent idle sleep on for all hosts",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-3",
      title: "Use Omnyo on your phone",
      lead: "Pick up any thread where you left it, answer your agents, or start new work.",
      body: (
        <>
          <Substeps>
            <li>
              In any phone browser, open your omnyo.link address and sign in
              with the same GitHub account. This works on Android too.
            </li>
            <li>On iPhone, you can use the Omnyo app instead.</li>
            <li>
              To pair the app, open <Ui icon="settings">Settings → Mobile</Ui>{" "}
              on your computer and choose <strong>Add mobile device</strong>. It
              shows once Omnyo connect is connected.
            </li>
            <li>
              In the app, choose <strong>Connect with Omnyo connect</strong>. If
              you've already added a server, open <strong>Servers</strong> and
              choose <strong>Add server</strong> first. Scan the QR code, or
              type the pairing code and choose <strong>Pair</strong>.
            </li>
          </Substeps>
          <p>
            Rather use your own network or Tailscale? Open that address in the
            phone's browser, or enter it in the app under{" "}
            <strong>Server URL</strong> and choose <strong>Connect</strong>.
          </p>
        </>
      ),
      shot: {
        src: "/guides/work-from-anywhere/window-phone.webp",
        alt: "Omnyo on a phone, showing the Resumable uploads thread with the agent's reply, a Finished summary, and an Ask a follow-up box",
        width: 780,
        height: 1688,
      },
      options: [],
    },
    {
      id: "step-4",
      title: "Get notified",
      lead: "Know when an agent finishes or needs you, even with the app closed.",
      body: (
        <Substeps>
          <li>
            In the app, open{" "}
            <strong>
              Settings → Servers and phone settings → Notifications
            </strong>
            , turn on <strong>Push notifications</strong> for your server, and
            allow them when your phone asks.
          </li>
          <li>
            On your computer, choose what reaches you in{" "}
            <Ui icon="settings">Settings → Push notifications</Ui>:{" "}
            <strong>Default notifications</strong>,{" "}
            <strong>Child thread notifications</strong>, and{" "}
            <strong>Phone only when away</strong>, which holds phone alerts
            while you're at a computer running the desktop app.
          </li>
        </Substeps>
      ),
      shot: {
        src: "/guides/run-an-agent-on-a-schedule/window-notify.webp",
        alt: "Omnyo's Push notifications settings, with Phone only when away, Web notifications, and Desktop notifications on, and an Allow notifications button",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
  ],
  troubleshooting: [
    {
      question: "My phone says disconnected while my computer is on",
      answer: (
        <ol>
          <li>
            Wait a moment. Omnyo reconnects on its own while the server runs.
          </li>
          <li>
            Check that the server's computer hasn't gone to sleep, and that{" "}
            <strong>Prevent idle sleep</strong> is on for it.
          </li>
          <li>
            On that computer, open{" "}
            <Ui icon="settings">Settings → Omnyo connect</Ui>. If it says{" "}
            <strong>Remote access is off</strong>, choose{" "}
            <strong>Turn on</strong>.
          </li>
          <li>
            In the app, if a banner or button says{" "}
            <strong>Sign in again</strong> or <strong>Pair again</strong>,
            choose it and follow the steps.
          </li>
        </ol>
      ),
    },
    SLEEP_TROUBLESHOOTING,
    {
      question: "I don't see Add mobile device",
      answer: (
        <ol>
          <li>
            Open <Ui icon="settings">Settings → Omnyo connect</Ui> and sign in
            to your Omnyo account.
          </li>
          <li>
            If it says <strong>Remote access is off</strong>, choose{" "}
            <strong>Turn on</strong> and wait for your address to show.
          </li>
          <li>
            Go back to <Ui icon="settings">Settings → Mobile</Ui>. If the
            connection method shows <strong>Manual</strong>, switch it to{" "}
            <strong>omnyo connect</strong>.
          </li>
        </ol>
      ),
    },
    MACHINE_DISCONNECTED_TROUBLESHOOTING,
    {
      question: "A machine is stuck updating",
      answer: (
        <ol>
          <li>Machines update themselves to match the server's version.</li>
          <li>
            If an update failed, open its menu in{" "}
            <Ui icon="settings">Settings → Machines</Ui> and choose{" "}
            <strong>Retry update</strong>.
          </li>
          <li>
            If it still fails, check the logs from the next question on that
            machine.
          </li>
        </ol>
      ),
    },
    {
      question: "I need Omnyo’s logs",
      answer: (
        <ol>
          <li>
            In the desktop app, choose{" "}
            <strong>View → Server &amp; Daemon Logs</strong>.
          </li>
          <li>
            Otherwise, open the newest <code>logs/server.N.log</code> and{" "}
            <code>logs/host-daemon.N.log</code> in Omnyo's data folder,{" "}
            <code>~/.omnyo</code> by default. Startup errors and crashes are in{" "}
            <code>logs/server-stdio.log</code> and{" "}
            <code>logs/host-daemon-stdio.log</code>.
          </li>
          <li>
            On a machine you added, look in{" "}
            <code>~/.omnyo-machines/&lt;server&gt;</code> by default instead.
          </li>
        </ol>
      ),
    },
  ],
  faq: [
    {
      question: "Do I need to install anything on my phone?",
      answer: (
        <p>
          No. You can open your omnyo.link address in any phone browser. On
          iPhone, the Omnyo app adds push notifications. An Android app is
          coming soon.
        </p>
      ),
    },
    {
      question: "How do my devices connect?",
      answer: (
        <ul>
          <li>
            <strong>The server</strong> runs on one computer, usually the first
            one you set Omnyo up on. It keeps your threads, settings, and
            history. While it's asleep or off, nothing can reach Omnyo.
          </li>
          <li>
            <strong>Machines</strong> are the computers that run agents. Each
            one connects to the server. The server's own computer is a machine
            too.
          </li>
          <li>
            <strong>Apps</strong>, like the desktop app, the mobile app, and any
            browser at your omnyo.link address, all open the same server. Your
            agents run on machines, not in the app you're looking at.
          </li>
        </ul>
      ),
    },
    {
      question: "Which of my computers is the server?",
      answer: (
        <p>
          Open <Ui icon="settings">Settings → Machines</Ui>. The server's
          computer has a server badge.
        </p>
      ),
    },
    {
      question:
        "I set up Omnyo on two computers. Why don’t they share threads?",
      answer: (
        <p>
          Each setup runs its own server. To use one Omnyo everywhere, keep the
          server on the computer that stays on, and add the other one from{" "}
          <Ui icon="settings">Settings → Machines</Ui>. New threads can then run
          on either computer.
        </p>
      ),
    },
    {
      question: "Does quitting the desktop app stop my agents?",
      answer: (
        <p>
          On the server's computer, yes. Agents, automations, and remote access
          stop until you open it again. On a Mac, closing the window keeps Omnyo
          running.
        </p>
      ),
    },
    {
      question: "Do my terminal sessions show up?",
      answer: (
        <p>
          Not live. Omnyo doesn't attach to a session still running in a
          terminal, but Chat import brings in your recent Claude Code and Codex
          CLI chats so you can continue them in Omnyo. Find it under{" "}
          <Ui icon="settings">Settings → Chat import</Ui>, or run{" "}
          <code>omnyo chat-import scan</code>.
        </p>
      ),
    },
    LINK_ACCESS_FAQ,
    {
      question: "Where does my work live?",
      answer: (
        <p>
          On your own computer. The server keeps your projects, threads, and
          settings, and agents run on your machines with the AI providers you
          chose. Omnyo connect only relays the connection.
        </p>
      ),
    },
    COST_FAQ,
  ],
  closer: {
    title: "Take your agents with you",
    body: "Your agents keep running on your computer. Check in from anywhere through Omnyo connect.",
  },
};
