import type { ReactNode } from "react";

import { Substeps, Ui } from "../guide-blocks";
import type { GuideFaq, GuideShot, GuideStep } from "../guide-types";
import { AGENTS_FAQ } from "./faq";

export function annotateStep({
  title,
  lead,
  open,
  target,
  note,
  shot,
}: {
  title: string;
  lead: string;
  open: ReactNode;
  target: string;
  note: string;
  shot: GuideShot;
}): GuideStep {
  return {
    id: "annotate",
    title,
    lead,
    body: (
      <Substeps>
        <li>{open}</li>
        <li>
          Choose <Ui icon="annotate">Annotate elements</Ui> in the toolbar and
          click {target}.
        </li>
        <li>
          In the box, write {note} and choose <strong>Add to prompt</strong>.
          Add as many as you like, then send.
        </li>
        <li>
          To send a cropped screenshot with each note, turn on{" "}
          <strong>Design Mode</strong> (the paintbrush next to Annotate
          elements) before you click.
        </li>
      </Substeps>
    ),
    shot,
    options: [],
  };
}

export const PLUGINS_STEP: GuideStep = {
  id: "plugins",
  title: "Check the browser plugins are on",
  lead: (
    <>
      The Browser Automation plugin gives your agent a browser. The Agent
      Annotations plugin lets you point at what you mean.
    </>
  ),
  body: (
    <Substeps>
      <li>
        Open <Ui icon="settings">Settings → Installed plugins</Ui> with the gear
        at the bottom left, or press ⌘,. Search for “browser”.
      </li>
      <li>
        Browser Automation and Agent Annotations come with Omnyo and are on by
        default. If either switch is off, turn it on.
      </li>
    </Substeps>
  ),
  shot: {
    src: "/guides/agent-browser/window-plugins-sidebar.webp",
    alt: "Omnyo's Installed plugins settings filtered to browser, with Agent Annotations, Browser Automation, and PDF preview all switched on",
    width: 2048,
    height: 1280,
  },
  options: [],
};

export const SIGN_INS_STEP: GuideStep = {
  id: "sign-ins",
  title: "Import your browser logins",
  lead: "Your agent can open the sites you use, logged in as you.",
  body: (
    <Substeps>
      <li>
        In the Omnyo desktop app, open{" "}
        <Ui icon="settings">Settings → Browser</Ui>.
      </li>
      <li>
        Choose <strong>Import…</strong> next to your browser, like Chrome, and
        pick a profile if asked. On a Mac, Chrome and other Chromium browsers
        can stay open. Firefox and Safari show <strong>Running</strong>: quit
        them, then choose <strong>Recheck</strong>.
      </li>
      <li>
        To keep your logins current, turn on <strong>Keep logins synced</strong>{" "}
        and pick a profile under <strong>Sync from</strong>, or choose{" "}
        <strong>Connect</strong> next to your default browser. Omnyo then
        refreshes them every 15 minutes.
      </li>
    </Substeps>
  ),
  shot: {
    src: "/guides/agent-browser/window-sign-ins.webp",
    alt: "Omnyo's Browser settings with Google Chrome ready to import, Firefox needing to quit, Safari needing Full Disk Access, and a Keep logins synced switch with Connect Google Chrome",
    width: 2048,
    height: 1280,
  },
  options: [],
};

export const BROWSER_TROUBLESHOOTING: [GuideFaq, ...GuideFaq[]] = [
  {
    question: "Browser Automation is off",
    answer: (
      <ol>
        <li>
          Open <Ui icon="settings">Settings → Installed plugins</Ui> and search
          for “browser”.
        </li>
        <li>
          Turn on the switch for <strong>Browser Automation</strong>. It comes
          with Omnyo and starts right away.
        </li>
      </ol>
    ),
  },
  {
    question: "I don't see Annotate elements",
    answer: (
      <ol>
        <li>
          <strong>Annotate elements</strong> is in a Browser tab in the Omnyo
          desktop app. In the web app, expand your agent's live preview in the
          thread and choose <strong>Annotate</strong> instead.
        </li>
        <li>
          In <Ui icon="settings">Settings → Installed plugins</Ui>, check that{" "}
          <strong>Agent Annotations</strong> is switched on.
        </li>
        <li>
          If your agent is using the tab, choose <strong>Take over</strong>{" "}
          first.
        </li>
      </ol>
    ),
  },
  {
    question: "The browser won't start",
    answer: (
      <ol>
        <li>
          Check that the machine is connected in{" "}
          <Ui icon="settings">Settings → Machines</Ui>.
        </li>
        <li>
          The first run installs the browser tools on that machine, so it needs
          network access and npm. A fresh browser also needs Chrome or Chromium
          installed there.
        </li>
        <li>
          For a Browser tab, keep the Omnyo desktop app open, then ask again.
        </li>
      </ol>
    ),
  },
  {
    question: "The site still asks me to sign in",
    answer: (
      <ol>
        <li>
          A fresh browser starts signed out. Ask your agent to use a Browser tab
          instead.
        </li>
        <li>
          In <Ui icon="settings">Settings → Browser</Ui>, import again, or turn
          on <strong>Keep logins synced</strong> so new logins carry over every
          15 minutes.
        </li>
        <li>
          Still signed out? Sign in once in a Browser tab. It stays signed in.
        </li>
      </ol>
    ),
  },
  {
    question: "I can't import from my browser",
    answer: (
      <ol>
        <li>
          For Firefox or Safari, or any browser on Linux, quit it completely,
          then choose <strong>Recheck</strong>. Chrome and other Chromium
          browsers on a Mac can stay open.
        </li>
        <li>
          For Safari, choose <strong>Grant access…</strong> and turn on Full
          Disk Access for Omnyo. If macOS asks for Keychain access for Chrome,
          choose <strong>Always Allow</strong>.
        </li>
        <li>
          Choose <strong>Refresh</strong> to look for browsers again.
        </li>
      </ol>
    ),
  },
  {
    question: "The live preview says Ended",
    answer: (
      <p>
        Your agent closed its browser, or it sat unused for 30 minutes. A
        session also ends after 8 hours. The thread keeps the last view. Ask
        your agent to open it again.
      </p>
    ),
  },
];

export const BROWSER_FAQ: GuideFaq[] = [
  AGENTS_FAQ,
  {
    question: "Do I need the desktop app?",
    answer: (
      <p>
        Not for a fresh browser: your agent can open Chrome on any connected Mac
        or Linux machine. You watch it in the thread, and you can expand the
        preview to try phone and tablet sizes or annotate it. Browser tabs and
        your logins need the desktop app.
      </p>
    ),
  },
  {
    question: "Can I stop the agent or step in?",
    answer: (
      <p>
        Yes. A Browser tab shows a bar while your agent controls it. Choose{" "}
        <strong>Take over</strong> to click and type yourself, like to enter a
        sign-in code, or <strong>Stop</strong> to end its control.
      </p>
    ),
  },
  {
    question: "Can my agent see my passwords?",
    answer: (
      <p>
        No. Omnyo imports your logins, not your saved passwords, so your agent
        opens sites already signed in without seeing a password. Your logins
        stay in Omnyo's Browser on this computer, and the prompt from{" "}
        <strong>Copy for agent</strong> tells your agent never to read or print
        them.
      </p>
    ),
  },
  {
    question: "Can the browser run on a different computer?",
    answer: (
      <p>
        Yes. Ask for the browser on the machine you want. There,{" "}
        <code>localhost</code> means that computer, so use an address it can
        reach.
      </p>
    ),
  },
  {
    question: "Does it need macOS Automation permission?",
    answer: (
      <p>
        No. Browser Automation talks to Chrome and Omnyo's Browser directly, so
        it doesn't need Accessibility or Automation permission.
      </p>
    ),
  },
];
