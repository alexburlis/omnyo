import type { ComparisonBody } from "../comparison-types";

export const page: ComparisonBody = {
  headline: "Codex vs Claude\u00a0Code",
  lede: "Published evidence does not show that Codex or Claude Code is better overall. On the Terminal-Bench 4.1 leaderboard on 18 November 2026, their best entries were less than four points apart and their 95% confidence intervals overlapped.[^1] The differences you can check are in price, plan limits, what a new session may do on your machine, and Windows support.",
  points: [
    {
      title: "No benchmark settles it",
      body: "On Terminal-Bench 4.1 the best entries of each sit within overlapping confidence intervals, and Claude Code's Opus 5.5 run was listed at more than three times the cost of Codex's GPT-6.2 Astra run.[^1] Anthropic has written that at current capability levels benchmark margins have become a less reliable guide to real-world differences.[^2]",
    },
    {
      title: "Price and safety defaults differ",
      body: "ChatGPT Free includes limited Codex access in the desktop app, subject to rollout, while Claude Code starts with Claude Pro at $20 a month.[^3][^4][^5] In a version-controlled folder Codex recommends a workspace-write sandbox with on-request approvals; interactive Claude Code sessions start in auto mode, where a classifier model reviews actions, with the Bash sandbox off.[^6][^7][^8]",
    },
    {
      title: "You can run both",
      body: "Omnyo runs the real Codex and Claude Code CLIs side by side on your own machines and subscriptions. Start the same task in two chats, one per agent, each in its own Git worktree, and compare the diffs yourself.",
    },
  ],
  tablesHeading: "Codex and Claude\u00a0Code side by side",
  tablesLede:
    "Price and limits come first. Where both tools do the same thing, both cells say so. Prices are in US dollars before tax.",
  tables: [
    {
      heading: "Price and plans",
      rows: [
        {
          label: "Cheapest way in",
          left: "ChatGPT Free and Go ($8 a month) include limited Codex access in the desktop app, subject to rollout.[^3][^4]",
          right:
            "Claude Code is not in the Claude Free plan. It starts with Claude Pro.[^5]",
        },
        {
          label: "$20 a month",
          left: "ChatGPT Plus, $20 a month: Codex on the web, in the CLI, in the IDE extension and on iOS.[^4]",
          right:
            "Claude Pro, $20 billed monthly or $17 a month billed annually ($200 up front): Claude Code in the terminal, IDEs, the desktop app and the web.[^5][^9]",
        },
        {
          label: "Higher individual plans",
          left: "ChatGPT Pro at $100, $200 or $500 a month. ChatGPT's pricing page lists its Codex access as Expanded.[^4][^3]",
          right:
            "Claude Max at $100 a month for 5x Claude Pro usage, and Claude Ultra at $200 for 10x Claude Pro usage every week.[^5]",
        },
        {
          label: "Teams",
          left: "ChatGPT Business: $20 per user a month billed annually, or $25 billed monthly, for two or more users.[^4]",
          right:
            "Claude Team, 2 to 150 seats: Standard $20 a seat billed annually or $25 monthly; Premium $100 or $125. Claude Code is included.[^5]",
        },
        {
          label: "Pay per token instead",
          left: "An OpenAI API key bills at API prices, not your plan.[^4] Per million tokens, up to 272K input tokens: GPT-6.2 Sol $2 input, $10 output; GPT-6.2 Astra $8 and $40.[^10]",
          right:
            "An ANTHROPIC_API_KEY bills at API rates, not your plan.[^11] Per million tokens: Sonnet 5.5 $2 input, $10 output; Opus 5.5, the default, $4 and $20; Fable 5.2 $8 and $40.[^5][^12][^13]",
        },
      ],
    },
    {
      heading: "Usage limits",
      rows: [
        {
          label: "How the limit works",
          left: "Shared with ChatGPT Work. Estimates are per five-hour period, and weekly limits may also apply.[^4]",
          right:
            "Shared with Claude. A session limit resets every five hours, and weekly limits apply as well.[^14]",
        },
        {
          label: "Published allowance",
          left: "Estimated, not fixed: 17 to 180 local messages per five hours with GPT-6.2 Sol and 6 to 50 with GPT-6.2 Astra on ChatGPT Plus and Standard Business.[^4]",
          right:
            "No fixed message count. Claude Pro gives at least 5x Free's usage per five-hour session, and Claude Max 5x Claude Pro's.[^5][^15]",
        },
        {
          label: "No five-hour limit",
          left: "ChatGPT Pro, from $100 a month, currently has no five-hour limit; weekly limits may still apply.[^4]",
          right:
            "Verified Claude Ultra accounts, at $200 a month, have no five-hour limit; the weekly limit still applies.[^11][^5]",
        },
        {
          label: "At the limit",
          left: "The agent can finish its current turn, subject to fair use. ChatGPT Plus and ChatGPT Pro can buy credits, and any user can keep running local tasks on an API key.[^4]",
          right:
            "Claude Code may finish the current step at the five-hour limit (once a week on Claude Pro; still rolling out).[^11] Usage credits or a Console account bill at API rates.[^16][^11]",
        },
      ],
    },
    {
      heading: "Where it runs",
      rows: [
        {
          label: "Windows",
          left: "The desktop app runs Codex natively in PowerShell with a Windows sandbox, or in WSL2.[^17] Windows 11 is recommended; Windows 10 1809 or newer is best effort.[^18]",
          right: "Natively on Windows 10 1809 or later, or inside WSL.[^19]",
        },
        {
          label: "Install",
          left: "A curl installer on macOS and Linux, a PowerShell installer on Windows, npm or Homebrew.[^20][^21]",
          right:
            "A native installer through curl on macOS, Linux and WSL or PowerShell on Windows; Homebrew, WinGet, or signed apt, dnf and apk repositories.[^19][^9]",
        },
        {
          label: "Linux desktop app",
          left: "The ChatGPT desktop app is in preview on Ubuntu 24.04 LTS and 26.04 LTS, Debian 13, Fedora 43 and 44 and current Arch Linux, on x64 and ARM64.[^22]",
          right:
            "The Claude desktop app is in beta on Debian-based systems only: Ubuntu 22.04 or later, or Debian 12 or later.[^23]",
        },
        {
          label: "IDEs",
          left: "An extension for VS Code, Cursor and Windsurf; Xcode and JetBrains IDEs offer Codex through their own integrations.[^24]",
          right:
            "VS Code, Cursor and other VS Code forks, and JetBrains IDEs such as IntelliJ and PyCharm.[^11] The JetBrains plugin is labelled Beta.[^25]",
        },
        {
          label: "Phone",
          left: "The ChatGPT app on iOS works with Codex in the cloud or on a connected Mac or Windows PC, depending on rollout and workspace settings.[^4][^26]",
          right:
            "The Code tab of the Claude app for iOS and Android holds cloud sessions and Remote Control.[^27]",
        },
        {
          label: "Cloud",
          left: "Each task gets its own workspace and can keep working while your computer is asleep; it needs a ChatGPT sign-in, not an API key.[^28][^29]",
          right:
            "Sessions at claude.ai/code on Claude Pro, Max, Ultra, Team and some Enterprise seats, each in an isolated Anthropic-managed VM unless routed to a self-hosted environment.[^30]",
        },
      ],
    },
    {
      heading: "Approvals and sandboxing",
      rows: [
        {
          label: "A new session",
          left: "In a version-controlled folder Codex recommends Auto: a workspace-write sandbox with on-request approvals. Elsewhere it recommends read-only.[^6]",
          right:
            "Interactive terminal and VS Code sessions start in auto mode, where a classifier model reviews actions instead of you.[^7]",
        },
        {
          label: "Shell sandbox",
          left: "The recommended presets sandbox commands from the start; workspace-write keeps command network access off unless you enable it.[^6]",
          right:
            "The Bash sandbox is off by default. Once on, it covers shell commands only, not file tools, MCP servers or hooks, and its allowed domains start empty.[^8]",
        },
        {
          label: "Native Windows",
          left: "Commands run in a Windows sandbox: on compatible devices mxc, which needs no administrator-approved setup, otherwise an elevated sandbox that does.[^18]",
          right:
            "Commands run unsandboxed. The sandbox works on macOS, Linux and WSL2.[^8]",
        },
        {
          label: "Turning checks off",
          left: "Full access in the desktop app and IDE extension pairs danger-full-access with approvals set to never; in the CLI, `--yolo` runs with no sandbox and no approvals.[^31][^6]",
          right:
            "bypassPermissions runs almost everything without asking, apart from deny rules and a few protected actions; Anthropic documents it for isolated containers and VMs only.[^7]",
        },
      ],
    },
    {
      heading: "Working in your code",
      rows: [
        {
          label: "Instruction file",
          left: "AGENTS.md, read before any work. Codex stops adding files at 32 KiB by default.[^32]",
          right:
            "CLAUDE.md, read at the start of every session. By default, AGENTS.md is read only when no CLAUDE.md or CLAUDE.local.md exists.[^33]",
        },
        {
          label: "Default context window",
          left: "272,000 tokens for GPT-6.2 Astra and 500,000 for GPT-6.2 Sol; up to 1 million after raising `model_context_window`.[^34]",
          right:
            "1M tokens by default for Fable models, Sonnet 5 and later, Haiku 5.5, and Opus 4.7 and later.[^12]",
        },
        {
          label: "Models",
          left: "GPT-6.2 Sol, which OpenAI recommends for everyday coding, and GPT-6.2 Astra for demanding work; with none set, Codex uses a recommended model.[^34]",
          right:
            "Opus 5.5 by default on paid Claude plans and the Anthropic API; also Sonnet 5.5 and Haiku 5.5, and Fable 5.2 when you pick it, for example with `/model fable`.[^12]",
        },
        {
          label: "Effort levels",
          left: "Light (Low in the CLI), Medium, High, Extra High and Max, plus Ultra on supported models, which hands separate parts of a task to subagents.[^34]",
          right:
            "low, medium, high, xhigh and max; Opus 5.5 and Fable 5.2 default to medium. Ultracode, a separate setting, has Claude orchestrate workflows for substantive tasks.[^12]",
        },
        {
          label: "Undo the agent's edits",
          left: "The Codex CLI docs advise making Git checkpoints before and after a task so you can revert changes.[^20]",
          right:
            "Edits are checkpointed before each prompt, and `/rewind` or `/undo` restores them. Files changed only by Bash are not tracked.[^35]",
        },
        {
          label: "Models from elsewhere",
          left: "A local model through Ollama or LM Studio with `--oss`, or OpenAI models through Amazon Bedrock.[^36][^37]",
          right:
            "Amazon Bedrock, Google Cloud's Agent Platform or Microsoft Foundry, set through environment variables.[^38]",
        },
      ],
    },
    {
      heading: "Extending and automating",
      rows: [
        {
          label: "Skills, hooks and MCP",
          left: "SKILL.md skills on the open agent skills standard, hooks and MCP servers.[^39][^40][^41]",
          right:
            "SKILL.md skills on the Agent Skills open standard, hooks and MCP servers.[^42][^43][^44]",
        },
        {
          label: "Parallel work",
          left: "Subagents are on by default and use more tokens than single-agent runs; the desktop app runs chats in Git worktrees.[^45][^46]",
          right:
            "Subagents, agent teams (experimental, off by default) and `/batch`, which splits one large change across 5 to 30 worktree-isolated subagents.[^47][^48]",
        },
        {
          label: "Scripts and CI",
          left: "`codex exec` runs non-interactively and can emit JSON Lines; openai/codex-action runs Codex in GitHub Actions.[^49][^50]",
          right:
            "`claude -p` runs non-interactively; anthropics/claude-code-action runs Claude Code in GitHub workflows.[^51][^52]",
        },
        {
          label: "Pull-request review on GitHub",
          left: "`@codex review` on ChatGPT Plus, ChatGPT Pro, Business and Enterprise/Edu, not with an API key; reviews through GitHub count as separate Code Review usage.[^53][^4]",
          right:
            "Managed Code Review on Team and Enterprise, billed in usage credits apart from plan usage; on any paid plan, the GitHub Action's review workflow posts PR reviews.[^54][^55][^52]",
        },
      ],
    },
    {
      heading: "Source and data",
      rows: [
        {
          label: "Licence",
          left: "The Codex CLI is open source (Apache-2.0); OpenAI says the IDE extension and Codex cloud are not.[^21][^56] The repository accepts no outside code contributions or pull requests.[^56]",
          right:
            "All rights reserved to Anthropic PBC; use is subject to Anthropic's Commercial Terms of Service.[^57]",
        },
        {
          label: "Training on individual plans",
          left: "ChatGPT's pricing page lists content on Free, Go, Plus and ChatGPT Pro as used to train OpenAI's models, with an opt-out.[^3]",
          right:
            "On Free, Claude Pro, Max and Ultra, Anthropic trains on your data, Claude Code sessions included, when the model-improvement setting is on; you can opt out.[^58][^5]",
        },
        {
          label: "Training on business plans and the API",
          left: "Business, Enterprise and Edu workspace data and API data are not used for training by default.[^59][^60]",
          right:
            "Anthropic does not train generative models on code or prompts sent under commercial terms, such as Team, Enterprise and the API, unless the customer opts in.[^58]",
        },
      ],
    },
    {
      heading: "Terminal-Bench 4.1, 18 November 2026",
      rows: [
        {
          label: "Score at max effort",
          left: "GPT-6.2 Astra sixth at 62.1% ± 2.3%; GPT-6.2 Sol seventh at 61.5% ± 2.8%.[^1]",
          right:
            "Opus 5.5 second at 65.8% ± 3.1%; Fable 5.2 tied second at 65.8% ± 2.8%.[^1]",
        },
        {
          label: "Listed cost of the full run",
          left: "$1.4k with GPT-6.2 Astra.[^1]",
          right: "$4.7k with Opus 5.5.[^1]",
        },
      ],
    },
  ],
  sections: [
    {
      heading: "What the published evidence says about quality",
      paragraphs: [
        "Terminal-Bench 4.1 is a public leaderboard whose entries name the agent as well as the model. On 18 November 2026 GitHub Copilot with Copilot Fusion led at 71.2% ± 2.9%. Claude Code's best entries, with Opus 5.5 and Fable 5.2, tied for second, and Codex's best, with GPT-6.2 Astra and GPT-6.2 Sol, ranked sixth and seventh; the table above gives each score.[^1] The Terminal-Bench team says its leaderboard experiments are supported by grants from OpenAI, Anthropic and others.[^61]",
        "Read those numbers with care. The 95% confidence intervals of the best entries overlap: 65.8% ± 3.1% for Claude Code with Opus 5.5 and 62.1% ± 2.3% for Codex with GPT-6.2 Astra.[^1] All four entries ran at max effort. Claude Code starts Opus 5.5 and Fable 5.2 at medium, and OpenAI advises starting Codex at the default effort and raising it when a task needs deeper planning.[^1][^12][^34] By the board's listed costs, the full run cost more than three times as much with Claude Code and Opus 5.5 as with Codex and GPT-6.2 Astra.[^1]",
        "Announcing Opus 5.5 on 22 September 2026, Anthropic wrote that at these levels of capability benchmark margins have become a less reliable guide to real-world differences, in a passage comparing Opus 5.5 with its own Fable 5.1.[^2] The comparison that counts for your work is your own: the same task, on your own code, in both.",
      ],
      bullets: [],
      visual: null,
    },
    {
      heading: "What each costs, and how far a plan goes",
      paragraphs: [
        "Both paid entry plans, ChatGPT Plus and Claude Pro, cost $20 a month; the tables above give the rest of each ladder.[^4][^5] To see what is left, Codex has a usage dashboard at chatgpt.com/codex/settings/usage and `/status` in the CLI, and Claude Code has `/usage` and Settings > Usage on claude.ai.[^4][^62][^14]",
        "How far a plan goes is harder to compare, because neither vendor sells a fixed number of messages. OpenAI publishes estimated ranges for ChatGPT Plus and Standard Business and says they are not fixed limits; Anthropic describes its plans as multiples of Free and Claude Pro usage.[^4][^5][^15] The five-hour limit goes away at different prices: every ChatGPT Pro plan, from $100 a month, currently has none, while on Claude only verified Ultra accounts, at $200 a month, have none. Weekly limits still apply on Ultra and may apply on ChatGPT Pro.[^4][^63]",
        "Codex shares its allowance with ChatGPT Work, which OpenAI lists separately from ChatGPT's Chat, and Claude Code shares its allowance with claude.ai and Claude Desktop, so other work in those products leaves less for coding.[^4][^14] Past the limit, both let you buy extra usage or switch to an API key billed at API rates.[^4][^16][^11]",
      ],
      bullets: [],
      visual: null,
    },
    {
      heading: "How each protects your machine by default",
      paragraphs: [
        "Codex starts from a sandbox. In a version-controlled folder it recommends its Auto preset: Codex reads, edits and runs commands inside the workspace and asks before editing outside it or using the network. Outside version control it recommends read-only, and the default workspace-write sandbox keeps command network access off unless you enable it.[^6] OpenAI describes workspace-write as letting the agent read files, edit within the workspace and run routine commands inside that boundary.[^31]",
        "Claude Code starts from a reviewer. Interactive terminal and VS Code sessions begin in auto mode, where a second model, the classifier, reviews actions instead of you; scripted `claude -p` runs begin in Manual mode, where any call that needs approval is denied unless an allow rule, hook or callback approves it.[^7] When you run Claude Code on its own, the Bash sandbox is off by default.[^8] Omnyo's own Claude Code sandbox setting is on by default. Once on, the sandbox covers shell commands only, sends traffic through a proxy whose allowed domains start empty, and can read most of the machine, including ~/.ssh, unless you add denyRead rules.[^8]",
        "Each tool also has the other approach. Codex's Approve for me, where available, sends eligible requests to cross the workspace boundary to automatic review, and Claude Code's sandbox turns on with `/sandbox`.[^64][^8] On native Windows they differ more: Codex runs commands in a Windows sandbox, while Claude Code runs them unsandboxed.[^17][^8]",
      ],
      bullets: [],
      visual: null,
    },
    {
      heading: "What is the same on both",
      paragraphs: ["Much of the daily work looks alike."],
      bullets: [
        "Both run as a CLI, in an IDE extension, in a desktop app, in the cloud and from a phone app.[^21][^24][^17][^28][^26][^9][^27]",
        "Both share their limit with another product from the same vendor, ChatGPT Work for Codex and Claude for Claude Code, and count usage in five-hour windows; Anthropic adds weekly limits, and OpenAI says weekly limits may also apply.[^4][^14]",
        "Both accept an API key billed at API rates instead of a plan, and both can run through Amazon Bedrock.[^4][^11][^37][^38]",
        "Both sandbox commands with Seatbelt on macOS and bubblewrap on Linux and WSL2, though Claude Code's sandbox must be turned on first.[^31][^8]",
        "Both have a non-interactive mode, SDKs for TypeScript and Python, and an official GitHub Action.[^49][^65][^50][^51][^66][^52]",
        "Both have a plan mode and a `/compact` command that summarizes the conversation so far.[^67][^7][^62]",
        "Both combine instruction files from several directories into one context.[^32][^33]",
        "Both shipped a CLI release on 18 November 2026: Codex CLI 0.170.0 and Claude Code 2.1.328.[^68][^69]",
      ],
      visual: null,
    },
    {
      heading: "AGENTS.md and CLAUDE.md: which file each reads",
      paragraphs: [
        "Codex reads AGENTS.md before doing any work. It reads a global file from ~/.codex first, preferring AGENTS.override.md, then files from the project root down to your directory, where nearer files come later and override earlier guidance. It stops adding files at 32 KiB by default and ignores other filenames unless you list them in `project_doc_fallback_filenames`.[^32]",
        "Claude Code reads CLAUDE.md at the start of every session: ./CLAUDE.md or ./.claude/CLAUDE.md, ~/.claude/CLAUDE.md for all projects, and CLAUDE.local.md for personal notes, which you add to .gitignore. It loads them from your directory and every directory above it and concatenates them rather than letting one override another.[^33]",
        "A project with AGENTS.md and no CLAUDE.md works in both, because Claude Code reads AGENTS.md by default only when no CLAUDE.md or CLAUDE.local.md exists.[^33] In Codex, `/init` generates an AGENTS.md, and `/import` brings Claude Code setup and recent chats over, converting their instruction files to AGENTS.md.[^67][^70]",
      ],
      bullets: [],
      visual: null,
    },
  ],
  picksHeading: "Which one fits you",
  picks: [
    {
      heading: "Choose Codex if",
      items: [
        "You want to start for free or for $8 a month: ChatGPT Free and Go include limited Codex access in the desktop app, subject to rollout.[^3][^4]",
        "You want an open-source CLI: the Codex CLI is Apache-2.0, though its repository takes no outside pull requests.[^21][^56]",
        "You work on native Windows and want the agent's commands sandboxed; Claude Code runs them unsandboxed there.[^18][^8]",
        "You want a desktop app on Fedora or Arch Linux: the ChatGPT desktop app's Linux preview covers both, while the Claude desktop app's Linux beta supports Debian-based systems only.[^22][^23]",
      ],
    },
    {
      heading: "Choose Claude Code if",
      items: [
        "You want a 1M-token context window without changing a setting; Codex starts GPT-6.2 Sol at 500,000 tokens and GPT-6.2 Astra at 272,000.[^12][^34]",
        "You want a classifier model to review actions by default in interactive terminal and VS Code sessions.[^7]",
        "You want hooks that ask a model to judge an event: Claude Code supports prompt-based hooks, and agent-based hooks as an experiment, while Codex parses those handler types but skips them.[^43][^40]",
        "You want several instruction files in one directory, such as path-scoped rules in .claude/rules/; Codex reads at most one instruction file per directory and splits guidance across nested directories.[^33][^32]",
      ],
    },
    {
      heading: "Run both if",
      items: [
        "You want to judge them on your own code, since their best Terminal-Bench entries sit within overlapping confidence intervals.[^1]",
        "You pay for a ChatGPT plan and a Claude plan, which each carry their own usage limits.[^4][^14]",
        "You want one agent to review what the other wrote, in its own chat.",
        "You have chats in both CLIs and want them in one place.",
      ],
    },
  ],
  together: {
    heading: "Run Codex and Claude\u00a0Code side by side in Omnyo",
    lede: "Omnyo is a free app that runs the real Codex CLI and the real Claude Code CLI on your own machines, signed in with your own subscriptions. It sells no AI service. Use it on Mac, Windows, iPhone and the web; Android is coming soon.",
    visual: "app-split",
    sections: [
      {
        heading: "Give both agents the same task",
        paragraphs: [
          "Codex and Claude Code are built in and on by default, and each chat runs one of them. To try one task on both, start a new chat on a Codex model, choose New worktree and send your prompt. Copy the prompt, start a second new chat on a Claude Code model, also with New worktree, and paste it. Then open both chats side by side with Open in split and read each one's diff.",
          "Omnyo does not score the results or pick a winner. You compare them yourself, or ask a third chat to review both. Separate worktrees keep the two sets of files apart, but they do not prevent merge conflicts later.",
        ],
        bullets: [
          "From the CLI, or from inside an agent's chat, it is two commands: `omnyo thread spawn --project PROJECT_ID --provider codex --new-environment worktree --prompt-file task.md`, then the same with `--provider claude-code`.",
          "Each agent's own CLI must be installed and signed in on the machine. Omnyo can run the install or update for you.",
        ],
        visual: "worktrees",
      },
      {
        heading: "Let one agent review the other",
        paragraphs: [
          "Any chat can start a chat on the other agent. A Claude Code chat that finishes a change can run `omnyo thread spawn --project $OMNYO_PROJECT_ID --provider codex --parent-self --environment $OMNYO_ENVIRONMENT_ID` with a review prompt, so the reviewer works in the same worktree, then message the reviewer with `omnyo thread tell`. It works the same the other way round.",
          "The reviewer's questions go to the chat that started it, not to you, and Omnyo posts the reviewer's outcome back automatically: completed with an excerpt, failed or interrupted. A review on the other agent happens only when you or an agent starts one. See [chats that work together](/features/multi-agent).",
        ],
        bullets: [],
        visual: "app-review",
      },
      {
        heading: "Hand a chat to the other agent",
        paragraphs: [
          "Handoff to new thread is the last item in a chat's model picker, and choosing the other agent's model in an existing chat's model picker starts the same handoff. It opens a new chat draft that starts with a Continue from link to the earlier chat, and you pick any agent and model for it. The new chat continues in the same workspace, the same worktree or checkout, and the two chats link to each other. It is not a copy of the agent's session, and it is a continuation of the earlier chat, not a second run beside it.",
        ],
        bullets: [],
        visual: null,
      },
      {
        heading:
          "See what each account has left and how each model uses tokens",
        paragraphs: [
          "Account Usage shows a small ring per provider, Claude and Codex, for the accounts you add to Account Pooler; open it for each account's plan, weekly bar and percentage left. Account Pooler uses those accounts one after another, in the priority order you set for each provider. See [usage tracking](/features/usage-tracking).",
          "Stats breaks tokens and agent time down by provider and by model, and its Model speed tab lists each model's estimated tokens per second. Stats records tokens, not cost, and its speed figures are estimates. Input and cache tokens do not compare like for like, because Codex counts cache inside input and Claude reports uncached input, so output tokens are the cleaner figure. See [Stats](/features/stats).",
        ],
        bullets: [],
        visual: "usage",
      },
      {
        heading: "Bring your existing chats from both",
        paragraphs: [
          "Chat import finds recent Codex CLI and Claude Code chats on the machine, including VS Code extension sessions, and you tick the ones you want. The first message you send forks the agent's own session, so the chat keeps the whole conversation and your CLI history stays as it was; while Account Pooler routes Codex, imported Codex chats cannot be continued. See [chat import](/features/chat-import).",
        ],
        bullets: [],
        visual: "import",
      },
    ],
  },
  faq: [
    {
      question: "What is the difference between Codex and Claude Code?",
      answer:
        "Codex is OpenAI's coding agent and Claude Code is Anthropic's, and each runs as a CLI, in an IDE extension, in a desktop app, in the cloud and from a phone app.[^21][^24][^17][^28][^26][^9][^27] They differ in price, since ChatGPT Free and Go include limited Codex access, subject to rollout, while Claude Code starts with Claude Pro, and in how a new session protects your machine.[^3][^5][^6][^7]",
    },
    {
      question: "Is Claude Code or Codex better?",
      answer:
        "Not on the published evidence. On Terminal-Bench 4.1 on 18 November 2026, Claude Code with Opus 5.5 scored 65.8% ± 3.1% and Codex with GPT-6.2 Astra 62.1% ± 2.3%, both at max effort, and their 95% confidence intervals overlap.[^1] Anthropic has written that at current capability levels benchmark margins have become a less reliable guide to real-world differences.[^2]",
    },
    {
      question: "Which is cheaper, Codex or Claude Code?",
      answer:
        "Neither across the board: ChatGPT Plus and Claude Pro both cost $20 a month, and ChatGPT Free and Go also include limited Codex access, subject to rollout.[^4][^5][^3] On an API key, GPT-6.2 Sol and Sonnet 5.5 both cost $2 input and $10 output per million tokens, GPT-6.2 Astra and Fable 5.2 both $8 and $40, and Opus 5.5, Claude Code's default, $4 and $20; OpenAI's prices are for prompts up to 272K input tokens.[^10][^5][^13][^12] Terminal-Bench 4.1 lists its full run at $1.4k for Codex with GPT-6.2 Astra and $4.7k for Claude Code with Opus 5.5.[^1]",
    },
    {
      question: "Are Codex and Claude Code free?",
      answer:
        "Codex partly: ChatGPT Free includes limited Codex access in the desktop app, subject to rollout.[^3][^4] The Codex CLI is open source under Apache-2.0, but running it needs a ChatGPT sign-in or an OpenAI API key.[^21][^29] Claude Code is not in the Claude Free plan; it comes with every paid Claude plan, from Claude Pro at $20 a month, and can also run on an Anthropic API key billed at API rates.[^5][^11]",
    },
    {
      question: "Is Codex or Claude Code open source?",
      answer:
        "The Codex CLI is open source under Apache-2.0, though its repository does not accept outside code contributions, and OpenAI says the IDE extension and Codex cloud are not open source.[^21][^56] Claude Code's repository licence reserves all rights to Anthropic PBC, so it is not under an open-source licence.[^57]",
    },
    {
      question: "Can I use Codex and Claude Code at the same time?",
      answer:
        "Yes. They are separate CLIs on separate subscriptions. In Omnyo each chat runs one agent, Codex chats and Claude Code chats run at the same time in the same project, and each chat can start in its own Git worktree.",
    },
    {
      question: "Does Claude Code read AGENTS.md?",
      answer:
        "Yes, by default, when no CLAUDE.md or CLAUDE.local.md exists in your directory or above it.[^33] Codex reads AGENTS.md and ignores other filenames unless you list them in `project_doc_fallback_filenames`, so a project with AGENTS.md and no CLAUDE.md works in both.[^32]",
    },
    {
      question: "Do Codex and Claude Code run on Windows?",
      answer:
        "Yes, both. The ChatGPT desktop app runs Codex natively in PowerShell with a Windows sandbox, or in WSL2, and OpenAI recommends Windows 11, with Windows 10 1809 or newer on a best-effort basis.[^17][^18] Claude Code runs natively on Windows 10 1809 or later or inside WSL, but on native Windows its commands run unsandboxed.[^19][^8]",
    },
    {
      question: "Will my code be used for training?",
      answer:
        "On individual plans it can be, and both offer an opt-out: OpenAI lists training for Free, Go, Plus and ChatGPT Pro, and Anthropic trains on Free, Claude Pro, Max and Ultra data, Claude Code sessions included, when the model-improvement setting is on.[^3][^5][^58] Business plans and the API are not used for training by default with either.[^59][^60][^58]",
    },
  ],
  sources: [
    { label: "Terminal-Bench: leaderboard", url: "https://www.tbench.ai/" },
    {
      label: "Anthropic: Claude Opus 5.5 announcement",
      url: "https://www.anthropic.com/claude-opus-5-5",
    },
    { label: "OpenAI: ChatGPT pricing", url: "https://chatgpt.com/pricing" },
    {
      label: "OpenAI: Codex pricing",
      url: "https://learn.chatgpt.com/docs/pricing",
    },
    { label: "Anthropic: Claude pricing", url: "https://claude.com/pricing" },
    {
      label: "OpenAI: Codex agent approvals and security",
      url: "https://learn.chatgpt.com/docs/agent-approvals-security",
    },
    {
      label: "Anthropic: Claude Code permission modes",
      url: "https://code.claude.com/docs/en/permission-modes",
    },
    {
      label: "Anthropic: Claude Code sandboxing",
      url: "https://code.claude.com/docs/en/sandboxing",
    },
    {
      label: "Anthropic: Claude Code overview",
      url: "https://code.claude.com/docs/en/overview",
    },
    {
      label: "OpenAI: API pricing",
      url: "https://developers.openai.com/api/docs/pricing",
    },
    {
      label: "Anthropic Help Center: Claude Code with a paid Claude plan",
      url: "https://support.claude.com/en/articles/11145838",
    },
    {
      label: "Anthropic: Claude Code model configuration",
      url: "https://code.claude.com/docs/en/model-config",
    },
    {
      label: "Anthropic: Claude models overview",
      url: "https://platform.claude.com/docs/en/about-claude/models/overview",
    },
    {
      label: "Anthropic Help Center: Usage limits",
      url: "https://support.claude.com/en/articles/11647753",
    },
    {
      label: "Anthropic Help Center: Max plan",
      url: "https://support.claude.com/en/articles/11049741",
    },
    {
      label: "Anthropic Help Center: Usage credits",
      url: "https://support.claude.com/en/articles/12429409",
    },
    {
      label: "OpenAI: ChatGPT desktop app for Windows",
      url: "https://learn.chatgpt.com/docs/windows/windows-app",
    },
    {
      label: "OpenAI: Codex Windows sandbox",
      url: "https://learn.chatgpt.com/docs/windows/windows-sandbox",
    },
    {
      label: "Anthropic: Claude Code setup",
      url: "https://code.claude.com/docs/en/setup",
    },
    {
      label: "OpenAI: Codex CLI",
      url: "https://learn.chatgpt.com/docs/codex/cli",
    },
    {
      label: "OpenAI: Codex README on GitHub",
      url: "https://github.com/openai/codex/blob/main/README.md",
    },
    {
      label: "OpenAI: ChatGPT desktop app for Linux",
      url: "https://learn.chatgpt.com/docs/linux/linux-app",
    },
    {
      label: "Anthropic: Claude desktop app on Linux",
      url: "https://code.claude.com/docs/en/desktop-linux",
    },
    {
      label: "OpenAI: Codex IDE extension",
      url: "https://learn.chatgpt.com/docs/codex/ide",
    },
    {
      label: "Anthropic: Claude Code in JetBrains IDEs",
      url: "https://code.claude.com/docs/en/jetbrains",
    },
    {
      label: "OpenAI: Codex on mobile",
      url: "https://learn.chatgpt.com/docs/mobile",
    },
    {
      label: "Anthropic: Claude Code on mobile",
      url: "https://code.claude.com/docs/en/mobile",
    },
    {
      label: "OpenAI: Codex cloud",
      url: "https://learn.chatgpt.com/docs/cloud",
    },
    {
      label: "OpenAI: Codex authentication",
      url: "https://learn.chatgpt.com/docs/auth",
    },
    {
      label: "Anthropic: Claude Code on the web",
      url: "https://code.claude.com/docs/en/claude-code-on-the-web",
    },
    {
      label: "OpenAI: Codex sandboxing",
      url: "https://learn.chatgpt.com/docs/sandboxing",
    },
    {
      label: "OpenAI: Codex AGENTS.md",
      url: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
    },
    {
      label: "Anthropic: Claude Code memory and CLAUDE.md",
      url: "https://code.claude.com/docs/en/memory",
    },
    {
      label: "OpenAI: Codex models",
      url: "https://learn.chatgpt.com/docs/models",
    },
    {
      label: "Anthropic: Claude Code checkpointing",
      url: "https://code.claude.com/docs/en/checkpointing",
    },
    {
      label: "OpenAI: Codex advanced configuration",
      url: "https://learn.chatgpt.com/docs/config-file/config-advanced",
    },
    {
      label: "OpenAI: Codex with Amazon Bedrock",
      url: "https://learn.chatgpt.com/docs/amazon-bedrock",
    },
    {
      label: "Anthropic: Claude Code authentication",
      url: "https://code.claude.com/docs/en/authentication",
    },
    {
      label: "OpenAI: Codex skills",
      url: "https://learn.chatgpt.com/docs/build-skills",
    },
    {
      label: "OpenAI: Codex hooks",
      url: "https://learn.chatgpt.com/docs/hooks",
    },
    {
      label: "OpenAI: Codex and MCP",
      url: "https://learn.chatgpt.com/docs/extend/mcp",
    },
    {
      label: "Anthropic: Claude Code skills",
      url: "https://code.claude.com/docs/en/skills",
    },
    {
      label: "Anthropic: Claude Code hooks guide",
      url: "https://code.claude.com/docs/en/hooks-guide",
    },
    {
      label: "Anthropic: Claude Code and MCP",
      url: "https://code.claude.com/docs/en/mcp",
    },
    {
      label: "OpenAI: Codex subagents",
      url: "https://learn.chatgpt.com/docs/agent-configuration/subagents",
    },
    {
      label: "OpenAI: Codex Git worktrees",
      url: "https://learn.chatgpt.com/docs/environments/git-worktrees",
    },
    {
      label: "Anthropic: Claude Code agents and parallel work",
      url: "https://code.claude.com/docs/en/agents",
    },
    {
      label: "Anthropic: Claude Code agent teams",
      url: "https://code.claude.com/docs/en/agent-teams",
    },
    {
      label: "OpenAI: Codex non-interactive mode",
      url: "https://learn.chatgpt.com/docs/non-interactive-mode",
    },
    {
      label: "OpenAI: Codex GitHub Action",
      url: "https://learn.chatgpt.com/docs/github-action",
    },
    {
      label: "Anthropic: Claude Code non-interactive mode",
      url: "https://code.claude.com/docs/en/headless",
    },
    {
      label: "Anthropic: Claude Code GitHub Actions",
      url: "https://code.claude.com/docs/en/github-actions",
    },
    {
      label: "OpenAI: Codex code review on GitHub",
      url: "https://learn.chatgpt.com/docs/third-party/github",
    },
    {
      label: "Anthropic: Claude Code Code Review",
      url: "https://code.claude.com/docs/en/code-review",
    },
    {
      label: "Anthropic: Code Review costs",
      url: "https://code.claude.com/docs/en/code-review-costs",
    },
    {
      label: "OpenAI: Codex open source",
      url: "https://learn.chatgpt.com/docs/open-source",
    },
    {
      label: "Anthropic: Claude Code licence on GitHub",
      url: "https://github.com/anthropics/claude-code/blob/main/LICENSE.md",
    },
    {
      label: "Anthropic: Claude Code data usage",
      url: "https://code.claude.com/docs/en/data-usage",
    },
    {
      label: "OpenAI: ChatGPT Work cloud security",
      url: "https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security",
    },
    {
      label: "OpenAI: API data controls",
      url: "https://developers.openai.com/api/docs/guides/your-data",
    },
    {
      label: "Terminal-Bench: Terminal-Bench 4.0 announcement",
      url: "https://www.tbench.ai/news/terminal-bench-4-0",
    },
    {
      label: "Anthropic: Claude Code commands",
      url: "https://code.claude.com/docs/en/commands",
    },
    {
      label: "Anthropic Help Center: Ultra plan",
      url: "https://support.claude.com/en/articles/17728952",
    },
    {
      label: "OpenAI: Codex permission modes",
      url: "https://learn.chatgpt.com/docs/permission-modes",
    },
    {
      label: "OpenAI: Codex SDK",
      url: "https://learn.chatgpt.com/docs/codex-sdk",
    },
    {
      label: "Anthropic: Claude Agent SDK overview",
      url: "https://code.claude.com/docs/en/agent-sdk/overview",
    },
    {
      label: "OpenAI: Codex CLI commands",
      url: "https://learn.chatgpt.com/docs/developer-commands?surface=cli",
    },
    {
      label: "OpenAI: Codex changelog",
      url: "https://learn.chatgpt.com/docs/changelog",
    },
    {
      label: "npm: @anthropic-ai/claude-code",
      url: "https://registry.npmjs.org/@anthropic-ai/claude-code",
    },
    {
      label: "OpenAI: Codex import",
      url: "https://learn.chatgpt.com/docs/import",
    },
  ],
  relatedFeatures: ["codex-gui", "claude-code-gui", "multi-agent"],
  relatedGuides: [
    {
      slug: "claude-code-and-codex-together",
      label: "Claude Code and Codex together",
    },
  ],
};
