import { RemoteServersConcept } from "../concepts";
import {
  CommandBlock,
  FileBlock,
  PromptBlock,
  Substeps,
  Ui,
} from "../guide-blocks";
import { skillOffer, withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import { MACHINE_DISCONNECTED_TROUBLESHOOTING } from "../shared/faq";
import { meta } from "./remote-dev-servers.meta";

const AGENT_PROMPT = withIntake(
  [
    { label: "Branches", hint: "the branches to preview" },
    { label: "Machine", hint: "an existing connected machine to run them on" },
    { label: "Checkout", hint: "the repo's folder on that machine" },
    { label: "Dev server command", hint: "check package.json, e.g. pnpm dev" },
  ],
  `Run a registered dev preview for each branch on my existing connected Omnyo machine.
Guide: /guides/remote-dev-servers

Preserve other work: don't stash, reset or switch branches in an existing checkout. Don't enroll machines, expose ports, change firewall rules or create public links. If the selected machine or source isn't available, report that before starting.

1. Check omnyo machine list and omnyo project show "$OMNYO_PROJECT_ID". Confirm the named machine is online and use its existing project checkout. If that checkout isn't registered, use omnyo project source add "$OMNYO_PROJECT_ID" --path <checkout> --machine <machine>. Do not create a machine or cloud resource.
2. For each named branch, start a thread on that machine with its own worktree based on the branch's current commit. Leave uncommitted work in other checkouts alone. Use omnyo thread spawn --json --project "$OMNYO_PROJECT_ID" --machine <machine> --new-environment worktree --base-branch <branch> --title "<short task name for the branch>" --prompt "Prepare this branch's dev preview. Reuse its .omnyo-env-setup.sh and .env.local, verify the actual dev-server command and a fixed free loopback port, then register the exact executable, argv and working directory with omnyo preview register --thread <this-thread-id> --url <original-loopback-url> --cwd <worktree> -- <verified-command-and-arguments>. Register first, then omnyo preview restart <preview-id> and omnyo preview status <preview-id>. Use an existing protected launcher for credentials; never put secrets in arguments. Keep the chosen port on restart. Don't adopt or stop another server or change application code. When online, run omnyo glance servers --remember <preview-id> and return the original loopback URL with the preview ID and status."
3. Read each thread's result. If a start is uncertain, check omnyo preview status <preview-id> before retrying with omnyo preview restart <preview-id>; a restart reuses a ready run, so never launch a second copy by hand. A foreign listener is a conflict; don't kill it or silently choose a different port. An offline machine must reconnect before restart.
4. Reply with branch, machine, preview ID, readiness and the original loopback URL. On my other signed-in devices, Omnyo opens the registered private preview instead. ${skillOffer("preview-branches", "my machine and verified dev server command")}`,
);

const SETUP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
pnpm install --frozen-lockfile
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
printf '\\nWEB_PORT=%s\\nAPI_PORT=%s\\n' "$(free_port)" "$(free_port)" >> .env.local`;

export const guide: Guide = {
  ...meta,
  description:
    "Give each branch its own worktree, dev server and saved preview on a second machine. Open each preview from Omnyo on any of your devices, and restart it from its saved command.",
  heroTop: null,
  concept: <RemoteServersConcept />,
  agentPrompt: AGENT_PROMPT,
  requirement: null,
  steps: [
    {
      id: "step-1",
      title: "Choose your dev box",
      lead: "Use a machine already connected to Omnyo, with the tools your project needs.",
      body: (
        <Substeps>
          <li>
            Open <Ui icon="settings">Settings → Machines</Ui> (the gear at the
            bottom left, then <strong>Settings</strong>, or press ⌘,) and find
            your dev box. If it isn't listed yet, choose{" "}
            <strong>Add a machine</strong> and follow the steps.
          </li>
          <li>
            Check that it shows as <strong>Online</strong>. If it shows{" "}
            <strong>Offline</strong>, open its ⋯ menu, choose{" "}
            <strong>Reconnect</strong>, and run the command it shows on that
            machine.
          </li>
          <li>
            Use the machine's existing checkout and development tools. You can
            keep working in that checkout over SSH.
          </li>
        </Substeps>
      ),
      shot: {
        src: "/guides/remote-dev-servers/window-add-machine.webp",
        alt: "Omnyo's Machines settings with two machines Online: MacBook Pro, marked this machine and server, and the dev box devbox",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-2",
      title: "Put your project on it",
      lead: "Point Omnyo at the checkout already on your dev box, and give every branch its own ports.",
      body: (
        <>
          <Substeps>
            <li>
              Open <Ui icon="settings">Settings → Projects</Ui> and choose your
              project.
            </li>
            <li>
              Under <strong>Checkouts</strong>, choose <strong>Set up</strong>{" "}
              next to the dev box. The button reads <strong>Offline</strong>{" "}
              until the machine reconnects.
            </li>
            <li>
              Choose <strong>Use an existing folder on</strong> your dev box and
              pick your checkout, or{" "}
              <strong>Clone from the project remote</strong> if there isn't one.
              Projects without a Git remote go straight to the folder picker.
            </li>
          </Substeps>
          <p>
            Commit a setup script at the repo root. Omnyo runs it in each new
            worktree it creates, so every branch installs its dependencies and
            chooses its ports. This example uses pnpm; adapt the command and
            ports to your project:
          </p>
          <FileBlock
            name="Example: .omnyo-env-setup.sh"
            contents={SETUP_SCRIPT}
          />
        </>
      ),
      shot: {
        src: "/guides/remote-dev-servers/window-checkouts.webp",
        alt: "The acme-web project's settings in Omnyo: Checkouts lists the MacBook Pro checkout and, for devbox, Not set up on this machine with a Set up button",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-3",
      title: "Start a thread per branch",
      lead: "Each thread gets its own worktree on the machine, so servers never step on each other.",
      body: (
        <Substeps>
          <li>
            Choose <strong>New thread</strong> and pick your project below the
            message box. If the project is on more than one machine, pick the
            dev box in the machine menu.
          </li>
          <li>
            Open the branch menu next to it (it reads <strong>main</strong>)
            and, under <strong>Start in</strong>, choose{" "}
            <strong>New worktree from main</strong>. New worktrees start from
            your default branch. To continue in a worktree already on the dev
            box, pick it under <strong>Worktrees</strong>. Describe the work,
            then send it.
          </li>
          <li>
            To start a worktree from another branch, ask the agent, or run{" "}
            <code>
              omnyo thread spawn --project &lt;project-id&gt; --machine
              &lt;machine&gt; --new-environment worktree --base-branch
              &lt;branch&gt; --title "&lt;task&gt;" --prompt "&lt;what to
              do&gt;"
            </code>
            . Repeat for each branch.
          </li>
        </Substeps>
      ),
      shot: {
        src: "/guides/remote-dev-servers/window-new-thread.webp",
        alt: "An unsent Omnyo draft for acme-web on devbox, with the Start in menu open, New worktree from main checked, and devbox's worktrees listed, including feat/search-highlight and fix/login-redirect",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-4",
      title: "Run and open each preview",
      lead: "Save the server's launch command once. Omnyo can check it, reopen it and restart it in the same worktree.",
      body: (
        <>
          <Substeps>
            <li>
              In the thread's worktree, verify the project's dev-server command
              and use the port saved in <code>.env.local</code>. Register that
              exact launch before starting it:
            </li>
          </Substeps>
          <CommandBlock
            command={
              'set -a; . ./.env.local; set +a\nomnyo preview register --thread "$OMNYO_THREAD_ID" --url "http://127.0.0.1:$WEB_PORT/" --cwd "$PWD" -- pnpm dev --host 127.0.0.1 --port "$WEB_PORT"'
            }
          />
          <p>
            Use the returned preview ID with{" "}
            <code>omnyo preview restart &lt;preview-id&gt;</code>, then{" "}
            <code>omnyo preview status &lt;preview-id&gt;</code>. Wait for{" "}
            <strong>online</strong> before opening it.
          </p>
          <p>
            Run <code>omnyo glance servers --remember &lt;preview-id&gt;</code>{" "}
            to show it in the thread's Dev servers shelf, just above the message
            box. On a phone, tap the server button in the thread header. Choose{" "}
            <strong>Open</strong> while it is <strong>Running</strong>. If it
            stopped or didn't start, choose <strong>Restart</strong> to run its
            saved command again. You can also open the loopback link returned in
            chat; on your other signed-in devices, Omnyo opens the registered
            private preview.
          </p>
          <PromptBlock
            name="Ask the agent"
            prompt="Verify this worktree's dev-server command and fixed loopback port. Register the exact argv and cwd with omnyo preview register, restart the saved preview, and check its status. When online, remember it with omnyo glance servers --remember and return its original loopback URL. Preserve other servers and use the existing protected launcher for credentials."
          />
        </>
      ),
      shot: {
        src: "/guides/remote-dev-servers/window-dev-server.webp",
        alt: "The Add search highlighting thread on devbox after the agent registered, restarted, and remembered its preview, with the Dev servers shelf above the message box showing localhost:5173, Running · devbox, and Open",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
  ],
  troubleshooting: [
    {
      question: "The preview is not ready",
      answer: (
        <ol>
          <li>
            Run <code>omnyo preview status &lt;preview-id&gt;</code> and read
            the reported state.
          </li>
          <li>
            Read the detail under the server in the Dev servers shelf, or the
            line the status command prints, such as "Another process is using
            this preview port." or "The preview command exited with code 1." The
            server must listen on the registered loopback host and port. To see
            its own logs, run the same command once in the thread's terminal,
            stop it, then restart the preview.
          </li>
          <li>
            Use <code>omnyo preview restart &lt;preview-id&gt;</code>, or{" "}
            <strong>Restart</strong> in the shelf when the server stopped or
            didn't start, to run the saved launch again. If another program
            already holds the port, the shelf shows <strong>Port in use</strong>
            . Omnyo won't stop that program for you: stop it yourself, then
            restart the preview on its saved port.
          </li>
        </ol>
      ),
    },
    {
      question: "Two branches fight over the same port",
      answer: (
        <ol>
          <li>
            Commit <code>.omnyo-env-setup.sh</code> from step 2, so each new
            worktree chooses its own ports.
          </li>
          <li>
            Register each server with the port in its own{" "}
            <code>.env.local</code>. Keep that port when restarting.
          </li>
          <li>
            Worktrees created before the setup script need their own port
            configuration; leave other worktrees unchanged.
          </li>
        </ol>
      ),
    },
    {
      question: "The thread failed while setting up its worktree",
      answer: (
        <ol>
          <li>
            Open the thread and read the{" "}
            <strong>.omnyo-env-setup.sh failed</strong> output.
          </li>
          <li>
            Fix the script, commit it, and start a new thread. Omnyo removes a
            worktree whose setup failed.
          </li>
          <li>
            Make optional setup steps non-fatal only when the worktree can
            safely run without them.
          </li>
        </ol>
      ),
    },
    {
      question: "A new worktree is missing .env or other files",
      answer: (
        <ol>
          <li>
            List them in a <code>.worktreeinclude</code> file at the repo root,
            one pattern per line.
          </li>
          <li>
            Put the files in the project's checkout on that machine. Omnyo
            copies them into each new worktree.
          </li>
          <li>
            Start a new thread. Keep secret values out of preview command
            arguments and links.
          </li>
        </ol>
      ),
    },
    MACHINE_DISCONNECTED_TROUBLESHOOTING,
    {
      question: "My app's sign-in or cookies do not behave as on localhost",
      answer: (
        <p>
          Managed previews isolate browser storage and cookies; they do not
          reuse your normal app session. Redirects outside the registered server
          are refused, so external sign-in redirects are not supported through
          this preview route.
        </p>
      ),
    },
  ],
  faq: [
    {
      question: "Does live reload work?",
      answer: (
        <p>
          Managed previews carry HTTP and supported WebSocket traffic to the
          registered server. Keep the app's dev-server URLs on that loopback
          endpoint.
        </p>
      ),
    },
    {
      question: "Who can open the preview?",
      answer: (
        <p>
          Only you: open it from Omnyo on any device signed in to your Omnyo.
          Registering a preview doesn't open a public port or create a public
          share link.
        </p>
      ),
    },
    {
      question: "Can I open previews from my phone or another network?",
      answer: (
        <p>
          Yes. Sign in to Omnyo connect with a free Omnyo account to reach your
          Omnyo, and its previews, from your phone or any browser. See{" "}
          <a href="/guides/work-from-anywhere">Work from anywhere</a>. You can
          use your own network, a company VPN or Tailscale instead. Either way,
          the dev server stays on loopback and needs no open firewall port.
        </p>
      ),
    },
    {
      question: "What should already be on my dev box?",
      answer: (
        <p>
          Your repo, its build tools and any local configuration. List untracked
          files every worktree needs in <code>.worktreeinclude</code>; Omnyo
          copies them from the existing checkout.
        </p>
      ),
    },
    {
      question: "Can I keep working in my checkout over SSH?",
      answer: (
        <p>
          Yes. Agents use their own worktrees, leaving your checkout, editor and
          terminals in place.
        </p>
      ),
    },
    {
      question: "Does this work with an existing cloud dev environment?",
      answer: (
        <p>
          Yes, if it is connected to Omnyo and stays awake. After a container
          restart, use <strong>Reconnect</strong> in{" "}
          <Ui icon="settings">Settings → Machines</Ui> and run the command it
          shows. Registering a preview doesn't add a new machine.
        </p>
      ),
    },
    {
      question: "How do I keep a machine from running too many agents?",
      answer: (
        <p>
          Open <Ui icon="settings">Settings → Concurrency limit</Ui> and set
          that machine's limit under <strong>Host limits</strong>.
        </p>
      ),
    },
    {
      question: "What happens to a server when I archive its thread?",
      answer: (
        <p>
          A server you started in the thread's terminal stops after the
          30-second undo window. A registered preview belongs to the worktree:
          five minutes after you archive the worktree's last thread, Omnyo
          removes the worktree and stops every process still running in it,
          including the preview. The branch is kept. Use{" "}
          <code>.omnyo-env-teardown.sh</code> for cleanup outside the worktree,
          such as its own containers.
        </p>
      ),
    },
    {
      question: "Does this cost anything?",
      answer: (
        <p>
          No. Omnyo is free to use, with no Omnyo subscription. Registering a
          preview only saves its launch command in your own Omnyo; your agents
          run on the subscriptions you already have.
        </p>
      ),
    },
  ],
  closer: {
    title: "Preview every branch",
    body: "Use the machines and agent subscriptions you already have.",
  },
};
