import { Check, CloudOff, LockIcon } from "./icons";

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

function typed(text: string, elapsed: number, start: number, perChar: number) {
  const count = Math.floor(
    clamp01((elapsed - start) / (text.length * perChar)) * text.length,
  );

  return text.slice(0, count);
}

function BrowserBar({
  url,
  tag,
  live,
}: {
  url: string;
  tag: string;
  live?: boolean;
}) {
  return (
    <div className="o2-urlbar">
      <span className="o2-urlbar-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="o2-urlbar-field">
        <LockIcon />
        {url}
      </span>
      <span className="o2-urlbar-tag">{tag}</span>
      {live ? (
        <span className="o2-live">
          <i />
          Live
        </span>
      ) : null}
    </div>
  );
}

const NOTES = [
  { title: "Ferry timetable", meta: "Lisbon · now" },
  { title: "Day 3: Alfama", meta: "Lisbon · 2h" },
  { title: "Packing list", meta: "Trips · Mon" },
  { title: "Bakery near the hostel", meta: "Lisbon · Sun" },
];

export function PreviewPanel({ elapsed }: { elapsed: number }) {
  const saved = elapsed >= 7700;
  const reloading = elapsed >= 7700 && elapsed < 8500;
  const line = typed("Last ferry back is 21:00, not 22:00.", elapsed, 900, 150);

  return (
    <div className="o2-panel-body o2-preview">
      <BrowserBar url="localhost:5173/notes/ferry" tag="offline-drafts" live />
      <div className={reloading ? "o2-reload o2-reload--on" : "o2-reload"} />
      <div className="o2-app">
        <aside className="o2-app-side">
          <div className="o2-app-brand">
            <span className="o2-app-logo" />
            Plover
          </div>
          {NOTES.map((note, index) => (
            <div
              key={note.title}
              className={
                index === 0 ? "o2-app-note o2-app-note--on" : "o2-app-note"
              }
            >
              <b>{note.title}</b>
              <span>
                {note.meta}
                {index === 0 && saved ? <em className="o2-app-dot" /> : null}
              </span>
            </div>
          ))}
        </aside>
        <div className="o2-app-main">
          <div className="o2-app-toolbar">
            <span className="o2-app-crumb">Lisbon / Ferry timetable</span>
            <span
              className={
                saved ? "o2-app-state o2-app-state--saved" : "o2-app-state"
              }
            >
              {saved ? <Check size={11} /> : <CloudOff />}
              {saved ? "Saved on this device" : "Offline"}
            </span>
          </div>
          <h4 className="o2-app-title">Ferry timetable</h4>
          <p className="o2-app-p">
            08:40 Cais do Sodré to Cacilhas, then every 20 minutes.
          </p>
          <p className="o2-app-p">
            Buy the card at the kiosk, not the machine.
          </p>
          <p className="o2-app-p o2-app-p--typing">
            {line}
            <span className="o2-caret" />
          </p>
          <div className="o2-app-chips">
            <span>#lisbon</span>
            <span>#transport</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const RUN_ONE = [
  { at: 2600, text: "✓ sync.retry  run 1   212ms", tone: "ok" },
  { at: 2900, text: "✓ sync.retry  run 2   198ms", tone: "ok" },
  { at: 3200, text: "✓ sync.retry  run 3   205ms", tone: "ok" },
  {
    at: 3600,
    text: "✗ sync.retry  run 7   expected 2 retries, got 1",
    tone: "bad",
  },
  { at: 4000, text: "✓ sync.retry  run 8   201ms", tone: "ok" },
  {
    at: 4400,
    text: "✗ sync.retry  run 19  expected 2 retries, got 1",
    tone: "bad",
  },
  {
    at: 4800,
    text: "✗ sync.retry  run 33  expected 2 retries, got 1",
    tone: "bad",
  },
  {
    at: 5200,
    text: "✗ sync.retry  run 41  expected 2 retries, got 1",
    tone: "bad",
  },
  { at: 5800, text: "Tests  4 failed | 46 passed (50)", tone: "sum-bad" },
] as const;

const RUN_TWO = [
  { at: 9800, text: "~ test/sync.retry.test.ts  +9 −6", tone: "edit" },
  { at: 10900, text: "$ pnpm vitest sync.retry --repeat 50", tone: "cmd" },
  { at: 11400, text: "✓ sync.retry  runs 1–10   fake timers", tone: "ok" },
  { at: 12100, text: "✓ sync.retry  runs 11–20", tone: "ok" },
  { at: 12700, text: "✓ sync.retry  runs 21–30", tone: "ok" },
  { at: 13300, text: "✓ sync.retry  runs 31–40", tone: "ok" },
  { at: 13900, text: "✓ sync.retry  runs 41–50", tone: "ok" },
  { at: 14400, text: "Tests  50 passed (50)", tone: "sum-ok" },
] as const;

export function TerminalPanel({ elapsed }: { elapsed: number }) {
  const lines = [
    { at: 2400, text: "$ pnpm vitest sync.retry --repeat 50", tone: "cmd" },
    ...RUN_ONE,
    ...RUN_TWO,
  ].filter((line) => line.at <= elapsed);

  const busy =
    (elapsed > 2400 && elapsed < 6000) || (elapsed > 10900 && elapsed < 14400);

  return (
    <div className="o2-panel-body o2-term">
      <div className="o2-term-head">
        <span>zsh · plover-api</span>
        <span className="o2-term-branch">fix-sync-retry</span>
      </div>
      <div className="o2-term-lines">
        {lines.map((line) => (
          <div
            key={`${line.at}-${line.text}`}
            className={`o2-term-line o2-term-line--${line.tone}`}
          >
            {line.text}
          </div>
        ))}
        {busy ? <div className="o2-term-line o2-term-cursor" /> : null}
      </div>
    </div>
  );
}

const DIFF = [
  "export async function openDraftStore() {",
  '  const db = await openDB("plover", 2, { upgrade });',
  '  window.addEventListener("online", flushDrafts);',
  "  return db;",
  "}",
  "",
  "export async function saveDraft(draft: Draft) {",
  '  await db.put("drafts", { ...draft, savedAt: Date.now() });',
  "}",
  "",
  "export async function flushDrafts() {",
  '  for (const draft of await db.getAll("drafts")) {',
  "    await api.notes.upsert(draft);",
  '    await db.delete("drafts", draft.id);',
  "  }",
  "}",
];

export function DiffPanel({ elapsed }: { elapsed: number }) {
  const commented = elapsed >= 1700;
  const suggested = elapsed >= 9200;

  return (
    <div className="o2-panel-body o2-diff">
      <div className="o2-diff-head">
        <span className="o2-diff-file">src/sync/draftStore.ts</span>
        <span className="o2-diff-stat">
          <b>+38</b> <i>−0</i>
        </span>
      </div>
      <div className="o2-diff-code">
        {DIFF.map((line, index) => (
          <div key={`${index}-${line}`}>
            <div
              className={
                index === 2 && commented
                  ? "o2-dl o2-dl--add o2-dl--flag"
                  : "o2-dl o2-dl--add"
              }
            >
              <span className="o2-dl-n">{index + 1}</span>
              <span className="o2-dl-s">+</span>
              <code>{line}</code>
            </div>
            {index === 2 && suggested ? (
              <div className="o2-dl o2-dl--suggest">
                <span className="o2-dl-n" />
                <span className="o2-dl-s">+</span>
                <code>{"  await flushDrafts();"}</code>
              </div>
            ) : null}
            {index === 3 && commented ? (
              <div className="o2-comment">
                <div className="o2-comment-who">
                  <span className="o2-comment-dot" />
                  Codex · Reviewer
                </div>
                <p>
                  Only the <code>online</code> event flushes. Drafts queued
                  before a restart never upload.
                </p>
                {suggested ? (
                  <span className="o2-comment-tag">Suggestion added</span>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

const ISSUES = [
  {
    n: 214,
    title: "Sign-in link expires too fast",
    label: "bug",
    extra: "dup of #198",
    at: 4400,
  },
  { n: 215, title: "Dark mode for the map view", label: "feature", at: 5200 },
  { n: 216, title: "Search ignores accented letters", label: "bug", at: 5900 },
  {
    n: 217,
    title: "Trip dates shift by a day in Auckland",
    label: "bug",
    at: 6600,
  },
  { n: 218, title: "Import routes from GPX files", label: "feature", at: 7300 },
  {
    n: 219,
    title: "Export fails for notes with images",
    label: "bug",
    extra: "urgent",
    at: 8000,
  },
];

export function IssuesPanel({ elapsed }: { elapsed: number }) {
  const listed = elapsed >= 2400;

  return (
    <div className="o2-panel-body o2-issues">
      <div className="o2-issues-head">
        <span>Open issues · plover-web</span>
        <span className="o2-issues-count">{listed ? "6 new" : "…"}</span>
      </div>
      {ISSUES.map((issue, index) => {
        const shown = listed && elapsed >= 2400 + index * 120;
        const labelled = elapsed >= issue.at;

        return (
          <div
            key={issue.n}
            className={shown ? "o2-issue o2-issue--on" : "o2-issue"}
          >
            <span className="o2-issue-n">#{issue.n}</span>
            <span className="o2-issue-title">{issue.title}</span>
            <span className="o2-issue-tags">
              {labelled ? (
                <em className={`o2-tag o2-tag--${issue.label}`}>
                  {issue.label}
                </em>
              ) : null}
              {labelled && issue.extra ? (
                <em
                  className={
                    issue.extra === "urgent"
                      ? "o2-tag o2-tag--urgent"
                      : "o2-tag"
                  }
                >
                  {issue.extra}
                </em>
              ) : null}
            </span>
          </div>
        );
      })}
      <div className="o2-issues-foot">
        <span className="o2-issues-clock" />
        Next run tomorrow at 09:00
      </div>
    </div>
  );
}

export function BrowserPanel({ elapsed }: { elapsed: number }) {
  const phone = elapsed >= 5600;
  const sheet = elapsed >= 3500;
  const copied = elapsed >= 4400 && elapsed < 6400;

  const cursor =
    elapsed < 2900
      ? { x: 46, y: 62 }
      : elapsed < 3500
        ? { x: 84, y: 14 }
        : { x: 60, y: 72 };

  return (
    <div className="o2-panel-body o2-browser">
      <BrowserBar url="localhost:5175/notes/42" tag="share-sheet" />
      <div className="o2-browser-stage">
        <div className={phone ? "o2-vp o2-vp--phone" : "o2-vp"}>
          <div className="o2-vp-top">
            <span className="o2-app-logo" />
            <span className="o2-vp-title">Day 3: Alfama</span>
            <span
              className={
                sheet && !phone ? "o2-vp-share o2-vp-share--hit" : "o2-vp-share"
              }
            >
              Share
            </span>
          </div>
          <div className="o2-vp-body">
            <i style={{ width: "88%" }} />
            <i style={{ width: "72%" }} />
            <i style={{ width: "80%" }} />
            <i style={{ width: "46%" }} />
            <div className="o2-vp-photo" />
            <i style={{ width: "76%" }} />
          </div>
          <div className={sheet ? "o2-sheet o2-sheet--on" : "o2-sheet"}>
            <b>Share note</b>
            <span className="o2-sheet-row o2-sheet-row--hit">Copy link</span>
            <span className="o2-sheet-row">Invite to trip</span>
            <span className="o2-sheet-row">Export as PDF</span>
          </div>
          <div className={copied ? "o2-toast o2-toast--on" : "o2-toast"}>
            <Check size={11} />
            Link copied
          </div>
          {phone ? null : (
            <span
              className="o2-cursor"
              style={{ left: `${cursor.x}%`, top: `${cursor.y}%` }}
            />
          )}
        </div>
        <span className="o2-browser-size">
          {phone ? "390 × 844" : "1280 × 800"}
        </span>
      </div>
    </div>
  );
}
