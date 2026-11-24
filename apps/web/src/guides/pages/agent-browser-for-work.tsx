import { BrowserConcept } from "../concepts";
import { BulletList, PromptBlock } from "../guide-blocks";
import { withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import {
  annotateStep,
  BROWSER_FAQ,
  BROWSER_TROUBLESHOOTING,
  PLUGINS_STEP,
  SIGN_INS_STEP,
} from "../shared/browser";
import { meta } from "./agent-browser-for-work.meta";

const AGENT_PROMPT = withIntake(
  [
    { label: "Task", hint: "what you want found, compared, or filled in" },
    { label: "Sites", hint: "where to look" },
    { label: "Logins", hint: "sites that need your account, if any" },
    { label: "Bring back", hint: "e.g. a table with a source link per row" },
  ],
  `Use a real browser to do the web task above, and show me what you found.

Do every step below, with a Check after each step. Stop if a check fails and tell me what failed.

1. Check browser access. Run omnyo plugin list. Browser Automation and Agent Annotations come with Omnyo and are on by default; if either is off, enable it with omnyo plugin enable browser-automation or omnyo plugin enable agent-annotations. Then read omnyo guide browser and omnyo browser-automation --help.
   Check: both plugins are running.

2. Open a browser. Find the computer running the Omnyo desktop app with omnyo machine list, then run omnyo browser instances --host <desktop-host-id> --json. If a desktop instance is connected, open a Browser tab there so I can watch and my sign-ins work:
   omnyo browser-automation open --backend desktop --machine <desktop-host-id> --desktop <instance-id> --json
   If no desktop instance is connected and Logins lists any site, stop and tell me signed-in sites need the Omnyo desktop app open. Otherwise open headless Chrome on this thread's machine:
   omnyo browser-automation open --backend local --headless --machine <host-id> --json
   Keep the returned session ID. Emit the returned previewDirective once if present.
   Check: the first page loads. For a signed-in site, confirm the expected account is signed in. If it isn't, stop and ask me to sign in once in a Browser tab, to import my logins in Settings → Browser, or to turn on Keep logins synced there so they refresh every 15 minutes (omnyo browser cookie-sync enable with the host, instance, generation, --from, and --profile values from omnyo browser import-sources does the same once I've picked a profile). Never read or print cookie values.

3. Do the task. Take a fresh snapshot before each action and use its element references. Read pages instead of guessing, and keep a list of the sources you used. If a page doesn't state a number, say so instead of filling it in from memory. Don't buy anything, send messages, submit forms that commit me to something, or change account settings unless I asked for exactly that; stop and ask first.
   Check: you have the information or result I asked for, with the page each fact came from.

4. Report and leave the tab for feedback. If you used a desktop Browser tab, stop controlling it with omnyo browser-automation stop <session-id> so it stays open on the most relevant page, and tell me I can choose Annotate elements to point at anything to change or dig into. If you used headless Chrome, close it with omnyo browser-automation close <session-id> and give me the page URLs instead.
   Check: reply with the result in the format from my Bring back answer (by default, a table with a source per row), a source link for each fact, screenshots of anything I should look at, and what you couldn't do.

If it's a task I'll want again, offer to save these steps as an Omnyo skill in .omnyo/skills/<short-name>/SKILL.md with my answers filled in, or as an Omnyo automation if it should run on a schedule.`,
);

export const guide: Guide = {
  ...meta,
  description:
    "Your agent compares pricing pages, pulls numbers from your dashboards, and fills in forms, in a browser you can watch.",
  heroTop: null,
  concept: <BrowserConcept scene="work" />,
  agentPrompt: AGENT_PROMPT,
  requirement: "the Omnyo desktop app for sites you're logged in to",
  steps: [
    PLUGINS_STEP,
    {
      ...SIGN_INS_STEP,
      lead: "For dashboards and tools behind a login, start Omnyo's Browser signed in.",
    },
    {
      id: "ask",
      title: "Ask for the job",
      lead: "Say what you need, which sites to use, and what to bring back.",
      body: (
        <>
          <p>
            Choose <strong>New thread</strong>. In the row of project tiles,
            choose <strong>More</strong>, then{" "}
            <strong>Don't work in a project</strong>, and paste your request:
          </p>
          <PromptBlock
            name="Example"
            prompt="Compare the cheapest paid plans of Linear, Trello, and Asana from their pricing pages: the plan name and its price per user per month, billed yearly. Work in a Browser tab here so I can watch. Put the result in a table and link each price to the page it came from."
          />
          <p>Jobs that work well:</p>
          <BulletList>
            <li>
              <strong>Research.</strong> Compare plans, pricing, or reviews
              across sites.
            </li>
            <li>
              <strong>Dashboards.</strong> Pull this week's numbers from
              analytics, billing, or ad accounts into one summary.
            </li>
            <li>
              <strong>Forms.</strong> Fill in the same details on several sites,
              and stop before anything is submitted.
            </li>
            <li>
              <strong>Every week.</strong> Pair it with an{" "}
              <a href="/guides/run-an-agent-on-a-schedule">automation</a> and
              have the report ready each morning.
            </li>
          </BulletList>
        </>
      ),
      shot: {
        src: "/guides/agent-browser-for-work/window-ask.webp",
        alt: "The Compare paid plan prices thread in Omnyo, with a table of the cheapest paid plans of Linear, Trello, and Asana, each price linked to its pricing page, next to Asana's pricing page in a Browser tab",
        width: 2048,
        height: 1280,
      },
      options: [
        {
          title: "Watch it work, or step in",
          body: (
            <p>
              While your agent uses the tab, a bar shows it's in control. Choose{" "}
              <strong>Take over</strong> to click or type yourself, like for a
              two-factor code, or <strong>Stop</strong> to end its control.
            </p>
          ),
          shot: {
            src: "/guides/agent-browser-for-work/window-take-over.webp",
            alt: "The agent reading Trello's pricing page in an Omnyo Browser tab, under a bar that says Browser Automation is controlling this tab, with Stop and Take over",
            width: 2048,
            height: 1280,
          },
        },
      ],
    },
    annotateStep({
      title: "Point at what to dig into",
      lead: "Select the thing on the page instead of describing it.",
      open: (
        <>
          In the Browser tab, choose <strong>Take over</strong> if your agent
          still has it.
        </>
      ),
      target: "the text, number, or button",
      note: "your question or request",
      shot: {
        src: "/guides/agent-browser-for-work/window-annotate.webp",
        alt: "Asana's pricing page in an Omnyo Browser tab with Annotate elements on, the Starter plan's price selected, and the note: Add each plan's monthly price as a second column",
        width: 2048,
        height: 1280,
      },
    }),
  ],
  troubleshooting: BROWSER_TROUBLESHOOTING,
  faq: [
    {
      question: "Do I need a code project?",
      answer: (
        <p>
          No. When you start the thread, choose <strong>More</strong> in the
          project tiles, then <strong>Don't work in a project</strong>, and ask
          for the job. The thread runs in your personal workspace.
        </p>
      ),
    },
    {
      question: "Will it buy things or send messages for me?",
      answer: (
        <p>
          Not unless you ask. The prompt tells it to stop and ask first. For a
          stricter limit, set <strong>Approvals</strong> to{" "}
          <strong>Accept Edits</strong>, so anything beyond the workspace asks
          you first. In a new thread, Approvals is in the <strong>+</strong>{" "}
          menu of the message box. In a running thread, it's the shield in the
          message box.
        </p>
      ),
    },
    {
      question: "What if a site doesn't list the number I asked for?",
      answer: (
        <p>
          Ask your agent to say so instead of guessing, and to link the page it
          checked so you can look yourself.
        </p>
      ),
    },
    ...BROWSER_FAQ,
  ],
  closer: {
    title: "Get the answer, with sources",
    body: "Free to use. Use the agents you already have.",
  },
};
