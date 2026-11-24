import { ScheduleConcept } from "../concepts";
import { Substeps, Ui } from "../guide-blocks";
import { withIntake } from "../prompt-intake";
import type { Guide } from "../guide-types";
import { AGENTS_FAQ } from "../shared/faq";
import { meta } from "./run-an-agent-on-a-schedule.meta";

const AGENT_PROMPT = withIntake(
  [
    {
      label: "Job",
      hint: "what each run does; a script can check first and start an agent only when there's work",
    },
    { label: "When", hint: "e.g. weekdays at 9am, with your timezone" },
    {
      label: "Results",
      hint: "one thread for reports, or a new worktree each run for code changes",
    },
    { label: "Notifications", hint: "yes or no" },
  ],
  `Set up an Omnyo automation for this project and test it once.
Guide: /guides/run-an-agent-on-a-schedule

Default Job: morning issue triage on weekdays at 9am, with reports in one thread. Ask for my timezone. Pass --project $OMNYO_PROJECT_ID to every omnyo automation command. If a step fails, stop and tell me the error.

1. Read \`omnyo automation create --help\`. If \`omnyo plugin list\` shows Automations is off, turn it on with \`omnyo plugin enable automations\`. For an agent job, pick a model from \`omnyo provider models <provider> --json\`.
2. If \`omnyo automation list\` already has this job, reuse it and skip to step 4.
3. Create it paused: \`omnyo automation create --name '<name>' --disabled\` with \`--cron '<expression>' --timezone <IANA zone>\` or \`--at <ISO time>\`, plus either:
   - Agent: \`--prompt '<prompt>' --provider <provider> --model <model> --permission-mode auto\`. For reports in one thread, start that thread with \`omnyo thread spawn --project $OMNYO_PROJECT_ID --title '<name>' --prompt '<its purpose>'\` and add \`--target-thread <its ID>\`. For code changes, add \`--new-environment worktree\` and tell it not to push.
   - Script: \`--script-file <path>\`. It starts an agent with \`"$OMNYO_CLI" thread spawn --project "$OMNYO_PROJECT_ID" --prompt '<task>'\` only when there's work, and prints nothing otherwise.
4. Test it with \`omnyo automation run <id>\`, then read the run's thread or output. If it doesn't do the job, leave it paused and tell me why.
5. Turn it on with \`omnyo automation resume <id>\`, asking me first for a one-time job. If Notifications is yes, send \`omnyo push-notifications test web\` (or \`test desktop\` if I use the Omnyo app) and ask me to confirm it arrived.

Reply with the automation ID, schedule, next run, and what the test produced.`,
);

export const guide: Guide = {
  ...meta,
  description:
    "Wake up to triaged issues, test results, or a dependency update. Run an agent once or on repeat, or have a script run first before an agent.",
  heroTop: null,
  concept: <ScheduleConcept />,
  agentPrompt: AGENT_PROMPT,
  requirement: null,
  steps: [
    {
      id: "step-1",
      title: "Open Automations",
      lead: "Every scheduled job lives in one list, with its schedule, next run, and an on/off switch.",
      body: (
        <Substeps>
          <li>
            Choose <strong>Automations</strong> in the rail on the far left. If
            it isn't there, open <strong>More</strong> at the bottom of the
            rail.
          </li>
          <li>
            Choose <strong>New automation</strong>. The new thread page opens
            with “Create a new Omnyo automation to” already typed. Or open{" "}
            <strong>Browse</strong> and choose a starting point, such as CI
            failure triage or Dependency drift.
          </li>
        </Substeps>
      ),
      shot: {
        src: "/guides/run-an-agent-on-a-schedule/window-list.webp",
        alt: "The Automations page in Omnyo listing four acme-web automations, CI failure check, Nightly test run, Draft release notes, and Weekly dependency update, with their schedules, next run times, and on/off switches",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-2",
      title: "Describe the job",
      lead: "Describe what to do, when, and where the results go. Your agent sets it up.",
      body: (
        <p>
          Pick the project, finish the sentence, and send it. Does the job need
          a site you're signed in to, like Linear or your analytics?{" "}
          <a href="/guides/agent-browser#sign-ins">
            Import your browser logins
          </a>{" "}
          into Omnyo first.
        </p>
      ),
      shot: {
        src: "/guides/run-an-agent-on-a-schedule/window-compose.webp",
        alt: "Omnyo's new thread page with acme-web selected and the message box reading: Create a new Omnyo automation to read new and updated GitHub issues every weekday at 9am Pacific. Group bugs and requests, flag regressions, and post a dated summary to one thread. Create it paused so I can test it.",
        width: 2048,
        height: 1280,
      },
      options: [
        {
          title:
            "Check with a script first, and wake an agent only when there's work",
          body: (
            <p>
              Ask for a script instead, like “every 15 minutes, check main for a
              failed CI run, and if there is one, start a Codex thread to fix
              it.” Scripts run without a model, so frequent checks use none of
              your plan. Quiet runs are skipped and show “empty output”.
            </p>
          ),
          shot: {
            src: "/guides/run-an-agent-on-a-schedule/window-script.webp",
            alt: "The CI failure check script automation in Omnyo, with a bash script that starts a Codex thread when main fails CI, a 15-minute schedule, and two skipped runs marked empty output",
            width: 2048,
            height: 1280,
          },
        },
        {
          title: "Run it once, later",
          body: (
            <p>
              Ask for a single run, like “tomorrow at 9am, draft release notes
              from this week's pull requests.” It shows as One time in
              Automations, with the date it will run.
            </p>
          ),
          shot: {
            src: "/guides/run-an-agent-on-a-schedule/window-once.webp",
            alt: "The one-time Draft release notes automation in Omnyo, set for Nov 16 at 9:00 AM, with its saved prompt, the Codex model 6.1-Sol Medium, and a Run now button",
            width: 2048,
            height: 1280,
          },
        },
        {
          title: "Send one message later",
          body: (
            <p>
              Type the message, open the arrow <Ui icon="send-options" /> next
              to the send button, and choose <strong>Send later…</strong>. Pick
              a time and choose <strong>Schedule send</strong>. The message
              waits above the box, where you can send it now or delete it. On a
              phone, press and hold the send button.
            </p>
          ),
          shot: {
            src: "/guides/run-an-agent-on-a-schedule/window-send-later.webp",
            alt: "The Fix flaky checkout test thread in Omnyo with an unsent follow-up, Rerun the checkout tests against main and tell me whether the flake is gone, and the send options menu open, showing Save draft… and Send later…",
            width: 2048,
            height: 1280,
          },
        },
      ],
    },
    {
      id: "step-3",
      title: "Run it now, then turn it on",
      lead: "You don't have to wait until morning to find out whether it works.",
      body: (
        <Substeps>
          <li>
            Open the automation and choose <strong>Run now</strong>. After the
            first run, <strong>Run now</strong> is in the <strong>⋯</strong>{" "}
            menu next to the switch.
          </li>
          <li>
            Under <strong>Runs</strong>, open the run and read the report.
          </li>
          <li>
            Once it's right, switch the automation on. To change what it does,
            choose the pencil next to <strong>Prompt</strong>, edit it, and
            choose <strong>Save Prompt</strong>.
          </li>
        </Substeps>
      ),
      shot: {
        src: "/guides/run-an-agent-on-a-schedule/window-detail-paused.webp",
        alt: "The paused Morning issue triage automation in Omnyo, with its 9AM Mon-Fri schedule, issue triage prompt, Codex model, Existing thread chip, and Run now button",
        width: 2048,
        height: 1280,
      },
      options: [],
    },
    {
      id: "step-4",
      title: "Get notified when it finishes",
      lead: "Open the report from a notification, or come back to the thread later.",
      body: (
        <Substeps>
          <li>
            Choose the gear <Ui icon="settings" /> at the bottom left, then{" "}
            <strong>Settings</strong> (or press ⌘,). Open{" "}
            <strong>Push notifications</strong>.
          </li>
          <li>
            Check that <strong>Web notifications</strong> (in a browser) or{" "}
            <strong>Desktop notifications</strong> (in the Omnyo app) is on,
            then choose <strong>Allow notifications</strong>.
          </li>
          <li>
            For your phone, keep <strong>Mobile notifications</strong> on and
            connect the Omnyo phone app in{" "}
            <Ui icon="settings">Settings → Mobile</Ui>. See{" "}
            <a href="/guides/work-from-anywhere">Work from anywhere</a>. With{" "}
            <strong>Phone only when away</strong> on, while you're using a
            computer with the Omnyo desktop app, your phone is notified only
            after that computer locks or sits idle for 2 minutes.
          </li>
          <li>
            Choose <strong>Send test notification</strong> to check that one
            arrives.
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
      question: "My automation didn't run",
      answer: (
        <ol>
          <li>
            Open it in <strong>Automations</strong> and check that its switch is
            on and the next run time is right.
          </li>
          <li>
            Check that Omnyo and the computer running the agent were awake at
            that time. Scheduling doesn't wake a sleeping computer; a missed run
            happens once when it's back. To keep a Mac from idle sleep while
            Omnyo runs, turn on <strong>Prevent idle sleep</strong> in{" "}
            <Ui icon="settings">Settings → Keep Awake</Ui>.
          </li>
          <li>
            Choose <strong>Run now</strong> in its <strong>⋯</strong> menu. If
            that works, the schedule or the computer was the problem.
          </li>
        </ol>
      ),
    },
    {
      question: "My automation turned itself off",
      answer: (
        <ol>
          <li>
            Open its latest runs. Three failures in a row pause an automation.
            Omnyo notifies you on the first failure and again when it pauses.
            Temporary provider errors are retried and don't count.
          </li>
          <li>
            It also pauses if the thread it posts to was archived or deleted, or
            was still starting or stopping when the run came due.
          </li>
          <li>
            Fix the cause, choose <strong>Run now</strong> in the{" "}
            <strong>⋯</strong> menu to check it, then switch it back on.
          </li>
        </ol>
      ),
    },
    {
      question: "A run failed",
      answer: (
        <ol>
          <li>
            Open the run under <strong>Runs</strong> and read its error.
          </li>
          <li>
            If the agent hit its usage limit, Omnyo retries the run later
            without pausing the automation. To use less of your plan, schedule
            heavy jobs overnight or use a script to skip runs with nothing to
            do.
          </li>
          <li>
            If the agent isn't signed in on that computer, sign in once, then
            choose <strong>Run now</strong> in the <strong>⋯</strong> menu.
          </li>
        </ol>
      ),
    },
    {
      question: "I get a new thread every morning",
      answer: (
        <p>
          That's the default. Ask your agent to post every run to one thread,
          like “send the morning triage to this thread.” Keep that thread for
          reports only.
        </p>
      ),
    },
    {
      question: "Every script run shows as skipped",
      answer: (
        <p>
          A script that exits without printing anything, or whose last line is{" "}
          <code>{'{"wakeAgent": false}'}</code>, counts as skipped. Its run
          shows “empty output” or “wakeAgent false”. Have it print a short
          result when there's something to report. A script that exits with an
          error or times out shows as failed; open the run to read its output.
        </p>
      ),
    },
    {
      question: "The notification never arrived",
      answer: (
        <ol>
          <li>
            Web notifications need an open Omnyo tab, and desktop notifications
            need the Omnyo app running.
          </li>
          <li>
            If <strong>Default notifications</strong> is set to Needs input
            only, finished runs don't notify you. Set the report thread to All
            activity in <Ui icon="more">Thread actions</Ui> →{" "}
            <strong>Notifications</strong>.
          </li>
          <li>
            Check the browser's notification permission and your device's Focus
            settings.
          </li>
          <li>
            For notifications with the app closed, connect the Omnyo phone app
            in <Ui icon="settings">Settings → Mobile</Ui>. With Phone only when
            away on, while you're using a computer with the Omnyo desktop app,
            the phone waits until that computer locks or sits idle for 2
            minutes.
          </li>
        </ol>
      ),
    },
  ],
  faq: [
    {
      question: "What can I automate?",
      answer: (
        <ul>
          <li>Triage new issues every morning and post a summary.</li>
          <li>Run the test suite nightly and fix what broke.</li>
          <li>Update dependencies weekly and open a pull request.</li>
          <li>Watch CI and start an agent when main goes red.</li>
          <li>Write release notes from the week's merged pull requests.</li>
        </ul>
      ),
    },
    {
      question: "What's the difference between an agent and a script?",
      answer: (
        <p>
          An agent automation sends a prompt to the agent and model you pick,
          and uses your plan each run. A script runs on the Omnyo server with no
          model, so it's free to run often, and it can start agent threads when
          it finds work.
        </p>
      ),
    },
    AGENTS_FAQ,
    {
      question: "How do I change an automation later?",
      answer: (
        <p>
          Open it in <strong>Automations</strong>. For an agent automation,
          choose the pencil next to <strong>Prompt</strong>. For a script,
          choose the pencil next to <strong>Script</strong> to change it in a
          chat. To change the schedule, ask your agent, like “move the morning
          triage to 8am.”
        </p>
      ),
    },
    {
      question: "Can an automation change code or open pull requests?",
      answer: (
        <p>
          Yes. Ask for a new worktree on every run, so each run gets its own
          branch, and say in the prompt whether it should push, open a pull
          request, or leave the change for you.
        </p>
      ),
    },
  ],
  closer: {
    title: "Have the report ready by morning",
    body: "Free to use. Use the agent subscriptions and machines you already have.",
  },
};
