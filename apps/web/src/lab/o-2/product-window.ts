export const WINDOW_WIDTH = 1280;

export const WINDOW_HEIGHT = 820;

const SANS = '"Inter Tight Variable", "Inter Variable", system-ui, sans-serif';

const MONO = '"Geist Mono Variable", ui-monospace, monospace';

const INK = "#111317";

const MUTED = "#6b6f78";

const HAIRLINE = "rgba(17, 19, 23, 0.08)";

interface ChatRow {
  title: string;
  agent: string;
  status: string;
  tone: string;
  active?: boolean;
}

const CHATS: readonly ChatRow[] = [
  {
    title: "Add a retry budget to uploads",
    agent: "Claude Code",
    status: "Building",
    tone: "#2f9e6b",
  },
  {
    title: "Review: upload retry budget",
    agent: "Codex",
    status: "Reviewing",
    tone: "#6a5cff",
    active: true,
  },
  {
    title: "Fix flaky checkout test",
    agent: "Codex",
    status: "Done",
    tone: "#9aa0aa",
  },
  {
    title: "Weekday issue triage",
    agent: "Automation",
    status: "Mon–Fri 09:00",
    tone: "#d9822b",
  },
  {
    title: "Search filters preview",
    agent: "Dev server",
    status: "feat/search-filters",
    tone: "#2b8fd9",
  },
];

const DIFF: readonly { sign: " " | "+" | "-"; text: string }[] = [
  { sign: " ", text: "export function nextDelay(attempt: number) {" },
  { sign: "-", text: "  return Math.min(250 * 2 ** attempt, budget.cap);" },
  {
    sign: "+",
    text: "  const delay = Math.min(250 * 2 ** attempt, budget.cap);",
  },
  { sign: "+", text: "  return delay * (0.8 + Math.random() * 0.4);" },
  { sign: " ", text: "}" },
  { sign: " ", text: "" },
  { sign: "+", text: "export function onUploadSuccess() {" },
  { sign: "+", text: "  budget.reset();" },
  { sign: "+", text: "}" },
];

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function pill(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  fill: string,
  color: string,
) {
  context.font = `500 13px ${SANS}`;
  const width = context.measureText(label).width + 20;
  roundRect(context, x, y, width, 24, 12);
  context.fillStyle = fill;
  context.fill();
  context.fillStyle = color;
  context.fillText(label, x + 10, y + 16.5);

  return width;
}

function wrap(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(" ");
  let line = "";
  let cursor = y;

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;

    if (context.measureText(next).width > maxWidth && line) {
      context.fillText(line, x, cursor);
      line = word;
      cursor += lineHeight;
    } else {
      line = next;
    }
  }

  if (line) context.fillText(line, x, cursor);

  return cursor + lineHeight;
}

export function drawProductWindow(canvas: HTMLCanvasElement) {
  const scale = canvas.width / WINDOW_WIDTH;
  const context = canvas.getContext("2d");

  if (!context) return;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, WINDOW_WIDTH, WINDOW_HEIGHT);
  context.textBaseline = "alphabetic";

  roundRect(context, 0, 0, WINDOW_WIDTH, WINDOW_HEIGHT, 26);
  context.fillStyle = "#ffffff";
  context.fill();
  context.save();
  context.clip();

  context.fillStyle = "#f5f5f3";
  context.fillRect(0, 0, 316, WINDOW_HEIGHT);
  context.fillStyle = HAIRLINE;
  context.fillRect(316, 0, 1, WINDOW_HEIGHT);
  context.fillRect(0, 52, WINDOW_WIDTH, 1);

  const lights = ["#ff5f57", "#febc2e", "#28c840"];
  lights.forEach((color, index) => {
    context.beginPath();
    context.arc(26 + index * 22, 26, 7, 0, Math.PI * 2);
    context.fillStyle = color;
    context.fill();
  });

  context.fillStyle = INK;
  context.font = `600 15px ${SANS}`;
  context.fillText("orbit-api", 112, 31);
  context.fillStyle = MUTED;
  context.font = `400 15px ${SANS}`;
  context.fillText("main", 184, 31);

  context.font = `600 12px ${MONO}`;
  context.fillStyle = MUTED;
  context.fillText("CHATS", 24, 90);

  roundRect(context, 222, 72, 72, 28, 14);
  context.fillStyle = INK;
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `600 13px ${SANS}`;
  context.fillText("New chat", 230, 91);

  CHATS.forEach((chat, index) => {
    const top = 116 + index * 76;

    if (chat.active) {
      roundRect(context, 12, top, 292, 66, 14);
      context.fillStyle = "#ffffff";
      context.fill();
      context.strokeStyle = HAIRLINE;
      context.lineWidth = 1;
      context.stroke();
    }

    context.beginPath();
    context.arc(32, top + 24, 5, 0, Math.PI * 2);
    context.fillStyle = chat.tone;
    context.fill();

    context.fillStyle = INK;
    context.font = `600 15px ${SANS}`;
    context.fillText(chat.title, 48, top + 29);
    context.fillStyle = MUTED;
    context.font = `400 13px ${SANS}`;
    context.fillText(`${chat.agent} · ${chat.status}`, 48, top + 50);
  });

  const left = 356;
  context.fillStyle = INK;
  context.font = `650 22px ${SANS}`;
  context.fillText("Review: upload retry budget", left, 104);

  let chip = left;
  chip += pill(context, chip, 120, "Codex", "#efedff", "#4b3fd6") + 8;
  chip +=
    pill(context, chip, 120, "feat/upload-retries", "#f1f2f4", "#3d4149") + 8;
  pill(
    context,
    chip,
    120,
    "Reviewing work by Claude Code",
    "#eaf6f0",
    "#1f7a50",
  );

  context.fillStyle = HAIRLINE;
  context.fillRect(left, 164, WINDOW_WIDTH - left - 40, 1);

  context.font = `400 16px ${SANS}`;

  const bubbleText =
    "Check the retry budget change on feat/upload-retries. Anything risky before I merge?";

  const bubbleWidth = 470;
  roundRect(context, WINDOW_WIDTH - 40 - bubbleWidth, 186, bubbleWidth, 72, 18);
  context.fillStyle = "#f1f2f4";
  context.fill();
  context.fillStyle = INK;
  wrap(
    context,
    bubbleText,
    WINDOW_WIDTH - 40 - bubbleWidth + 18,
    215,
    bubbleWidth - 36,
    24,
  );

  context.fillStyle = "#4b3fd6";
  context.font = `600 13px ${MONO}`;
  context.fillText("CODEX", left, 296);
  context.fillStyle = INK;
  context.font = `400 17px ${SANS}`;

  const after = wrap(
    context,
    "Two notes. The budget is never reset after a successful upload, so long sessions stop retrying. Delays also line up across clients, so add jitter.",
    left,
    326,
    760,
    27,
  );

  const diffTop = after + 6;
  const diffHeight = 30 + DIFF.length * 26;
  roundRect(context, left, diffTop, WINDOW_WIDTH - left - 40, diffHeight, 16);
  context.fillStyle = "#fafaf9";
  context.fill();
  context.strokeStyle = HAIRLINE;
  context.stroke();

  context.font = `500 13px ${MONO}`;
  context.fillStyle = MUTED;
  context.fillText("src/upload/retry.ts", left + 18, diffTop + 24);

  DIFF.forEach((line, index) => {
    const y = diffTop + 38 + index * 26;

    if (line.sign !== " ") {
      context.fillStyle = line.sign === "+" ? "#e3f5ea" : "#fde8e8";
      context.fillRect(left + 1, y, WINDOW_WIDTH - left - 42, 26);
    }

    context.fillStyle =
      line.sign === "+" ? "#1f7a50" : line.sign === "-" ? "#b42323" : "#3d4149";
    context.font = `450 14.5px ${MONO}`;
    context.fillText(`${line.sign}  ${line.text}`, left + 18, y + 18);
  });

  const composerTop = WINDOW_HEIGHT - 82;
  roundRect(context, left, composerTop, WINDOW_WIDTH - left - 40, 52, 26);
  context.fillStyle = "#ffffff";
  context.fill();
  context.strokeStyle = "rgba(17, 19, 23, 0.14)";
  context.stroke();
  context.fillStyle = "#9aa0aa";
  context.font = `400 16px ${SANS}`;
  context.fillText(
    "Ask Codex to apply both notes…",
    left + 22,
    composerTop + 32,
  );
  context.beginPath();
  context.arc(WINDOW_WIDTH - 66, composerTop + 26, 16, 0, Math.PI * 2);
  context.fillStyle = INK;
  context.fill();

  context.restore();

  roundRect(context, 0.5, 0.5, WINDOW_WIDTH - 1, WINDOW_HEIGHT - 1, 26);
  context.strokeStyle = "rgba(17, 19, 23, 0.12)";
  context.lineWidth = 1;
  context.stroke();
}
