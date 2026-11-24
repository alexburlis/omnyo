import "./claude-code-gui-diff.css";

export const label =
  "The diff side panel for a Claude Code chat: typing the filter !*.test.ts hides the test file, then the view switches from stacked to split to compare the old and new export code side by side.";

const FILTER = [..."!*.test.ts"];

const FILES = [
  { path: "src/export.ts", add: 48, del: 2, kind: "on" },
  { path: "src/invoices/Toolbar.tsx", add: 9, del: 1, kind: "keep" },
  { path: "src/export.test.ts", add: 7, del: 9, kind: "out" },
] as const;

const OLD = [
  { n: 12, text: "export function toCsv(rows) {", kind: "same" },
  { n: 13, text: 'return rows.map(String).join("\\n");', kind: "del" },
  { n: 14, text: "}", kind: "same" },
] as const;

const NEW = [
  { n: 12, text: "export function toCsv(rows) {", kind: "same" },
  { n: 13, text: 'const header = COLUMNS.join(",");', kind: "add" },
  { n: 14, text: "const body = rows.map(toRow);", kind: "add" },
  { n: 15, text: 'return [header, ...body].join("\\n");', kind: "add" },
  { n: 16, text: "}", kind: "same" },
] as const;

const STACKED = [
  OLD[0],
  OLD[1],
  NEW[1],
  NEW[2],
  NEW[3],
  { n: 16, text: "}", kind: "same" },
] as const;

function Line({
  line,
}: {
  line: { n: number; text: string; kind: "same" | "add" | "del" };
}) {
  return (
    <p className={`is-${line.kind}`}>
      <span>{line.n}</span>
      <i>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : ""}</i>
      <code
        className={
          line.text.startsWith("export") || line.text === "}" ? "" : "is-in"
        }
      >
        {line.text}
      </code>
    </p>
  );
}

export function Visual() {
  return (
    <div className="fv fv-claude-code-gui-diff" aria-hidden="true">
      <header className="fv-cd-bar">
        <b>Changes</b>
        <span className="fv-cd-count">
          <span className="is-a">3 files</span>
          <span className="is-b">2 files</span>
        </span>
        <span className="fv-cd-seg">
          <i />
          <span>Stacked</span>
          <span>Split</span>
        </span>
      </header>
      <p className="fv-cd-filter">
        <svg viewBox="0 0 24 24">
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        {FILTER.map((letter, index) => (
          <span key={index} className={`fv-cd-letter is-q${index}`}>
            {letter}
          </span>
        ))}
        <em className="fv-cd-placeholder">Filter paths</em>
      </p>
      <ul className="fv-cd-files">
        {FILES.map((file) => (
          <li key={file.path} className={`is-${file.kind}`}>
            <span>{file.path}</span>
            <b>+{file.add}</b>
            <em>−{file.del}</em>
          </li>
        ))}
      </ul>
      <div className="fv-cd-view">
        <p className="fv-cd-file fv-mono">src/export.ts</p>
        <div className="fv-cd-stacked fv-mono">
          {STACKED.map((line, index) => (
            <Line key={index} line={line} />
          ))}
        </div>
        <div className="fv-cd-split fv-mono">
          <div>
            {OLD.map((line) => (
              <Line key={line.n} line={line} />
            ))}
          </div>
          <div>
            {NEW.map((line) => (
              <Line key={line.n} line={line} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
