import type { CSSProperties } from "react";

export const label =
  "An Omnyo chat composer while you dictate: a live waveform replaces the bottom row. You press Add to draft, the waveform pauses while it transcribes, your words land in the draft, and Send posts them to the chat.";

const LEVELS = Array.from({ length: 96 }, (_, index) => {
  const phrase = 0.3 + 0.7 * Math.abs(Math.sin(index * 0.13));

  const syllable =
    0.55 + 0.45 * Math.sin(index * 0.9 + Math.sin(index * 0.37) * 2);

  return Math.min(0.92, Math.max(0.07, phrase * syllable));
});

const PITCH = 5;

const HEIGHT = 28;

const wave = (offset: number) =>
  LEVELS.map((level, index) => {
    const x = offset + index * PITCH + 1.5;
    const half = Math.max(0.5, (level * (HEIGHT - 4)) / 2);

    return `M${x} ${(HEIGHT / 2 - half).toFixed(2)}V${(HEIGHT / 2 + half).toFixed(2)}`;
  }).join("");

const PENCIL = "M14.5 5.5l4 4M4 20l1-4.5L15.5 5l4 4L9 19.5 4 20Z";

const TERMINAL = "M4 5h16v14H4zM8 10l2.5 2L8 14M12.5 14H16";

const TOOLS = [
  { icon: PENCIL, text: "Edited export.ts", stat: "+64" },
  { icon: PENCIL, text: "Edited InvoiceToolbar.tsx", stat: "+22 −12" },
  { icon: TERMINAL, text: "Ran pnpm test invoices", stat: "12 passed" },
] as const;

const SPAN = LEVELS.length * PITCH;

const PATH = wave(0) + wave(SPAN);

const ANSWER = "Use ISO dates, and add a header row.";

const MIC =
  "M12 3.5a3 3 0 0 0-3 3v4.5a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3";

const SEND = "M12 19V5M5.5 11.5 12 5l6.5 6.5";

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Track({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${SPAN * 2} ${HEIGHT}`}
      style={{ width: `${(SPAN * 4) / HEIGHT}em` }}
      aria-hidden="true"
    >
      <path d={PATH} />
    </svg>
  );
}

export function Visual() {
  return (
    <div className="fv fv-voice" aria-hidden="true">
      <div className="fv-voice-thread">
        <div className="fv-voice-log">
          <p className="fv-voice-user">
            Add a CSV export to the invoices page.
          </p>
          <div className="fv-voice-tools">
            <p className="fv-voice-tools-head">
              Edited 2 files, ran 1 command
              <Glyph d="m6 9 6 6 6-6" />
            </p>
            {TOOLS.map((tool) => (
              <p className="fv-voice-tool" key={tool.text}>
                <Glyph d={tool.icon} />
                {tool.text}
                <span>{tool.stat}</span>
              </p>
            ))}
          </div>
          <p className="fv-voice-say">
            The export works. Should the date column use ISO dates or the format
            shown in the table?
          </p>
          <p className="fv-voice-user fv-voice-sent">{ANSWER}</p>
        </div>
        <div className="fv-voice-composer">
          <p className="fv-voice-draft">
            <span className="fv-voice-placeholder">Ask for a follow-up</span>
            <span className="fv-voice-words">
              {ANSWER.split(" ").map((word, index) => (
                <span key={word} style={{ "--i": index } as CSSProperties}>
                  {word}{" "}
                </span>
              ))}
            </span>
          </p>
          <div className="fv-voice-rows">
            <div className="fv-voice-rec">
              <span className="fv-voice-cancel">
                <Glyph d="M17 7 7 17M7 7l10 10" />
              </span>
              <span className="fv-voice-wave">
                <Track className="fv-voice-track" />
                <span className="fv-voice-shine">
                  <span className="fv-voice-shine-in">
                    <Track className="fv-voice-frozen" />
                  </span>
                </span>
              </span>
              <span className="fv-voice-add">
                <i />
                <svg className="fv-voice-spin" viewBox="0 0 24 24">
                  <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
                </svg>
                <span className="fv-voice-tip">Add to draft</span>
              </span>
              <span className="fv-voice-send">
                <Glyph d={SEND} />
              </span>
            </div>
            <div className="fv-voice-bar">
              <Glyph d="M12 5v14M5 12h14" />
              <span className="fv-voice-model">
                <Glyph
                  className="fv-voice-mark"
                  d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
                />
                Opus 5.5
                <Glyph d="m6 9 6 6 6-6" />
              </span>
              <span className="fv-voice-mic">
                <Glyph d={MIC} />
              </span>
              <span className="fv-voice-send is-bar">
                <Glyph d={SEND} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
