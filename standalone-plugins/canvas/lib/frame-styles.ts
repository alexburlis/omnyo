export const canvasFrameStyles = `
:where(*) {
  box-sizing: border-box;
}
:where(html, body) {
  margin: 0;
  background: transparent;
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 13px;
  line-height: 1.5;
}
:where(body) {
  display: flow-root;
  --canvas-gap: 16px;
  --canvas-chart-height: 200px;
}
:where(h1, h2, h3, h4, p, figure) {
  margin: 0;
}
:where(h1, h2, h3, h4) {
  font-weight: 600;
  line-height: 1.3;
  text-wrap: balance;
}
:where(h1) { font-size: 24px; letter-spacing: -0.03em; }
:where(h2) { font-size: 20px; letter-spacing: -0.02em; }
:where(h3, h4) { font-size: 14px; }
:where(p + p, h1 + p, h2 + p, h3 + p, h4 + p) {
  margin-block-start: 8px;
}
:where(a) { color: var(--primary); text-underline-offset: 3px; }
:where(ul, ol) { margin: 8px 0; padding-inline-start: 20px; }
:where(li + li) { margin-block-start: 4px; }
:where(code, pre) { font-family: var(--font-mono); }
:where(button, select, input) {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 9px;
  background: var(--card);
  color: var(--foreground);
  font: inherit;
  font-size: 12px;
}
:where(button, select) { cursor: pointer; }
:where(button:disabled, input:disabled, select:disabled) { cursor: default; opacity: 0.6; }
:where(a, button, select, input):focus-visible {
  outline: 2px solid var(--ring, var(--primary));
  outline-offset: 2px;
}
:where(table, .canvas-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
:where(th, td) { padding: 9px 5px; border-block-end: 1px solid var(--border); text-align: end; }
:where(th) { color: var(--muted-foreground); font-size: 11px; font-weight: 500; }
:where(th:first-child, td:first-child) { text-align: start; overflow-wrap: anywhere; }
:where(tbody tr:last-child td) { border-block-end: 0; }
:where(svg) { max-width: 100%; }
:where(svg text) { fill: var(--muted-foreground); font-family: var(--font-sans); font-size: 11px; }
:where(.canvas-stack > * + *) { margin-block-start: var(--canvas-gap); }
:where(.canvas-row, .canvas-controls) { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
:where(.canvas-columns) {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: var(--canvas-gap);
}
:where(.canvas-metrics) {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--canvas-gap);
}
:where(.canvas-metric) { min-width: 0; }
:where(.canvas-label, .canvas-note, .canvas-caption) { color: var(--muted-foreground); font-size: 11px; }
:where(.canvas-value) {
  display: block;
  margin-block-start: 4px;
  font-size: 30px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.035em;
  line-height: 1.2;
}
:where(.canvas-caption, .canvas-note) { margin-block-start: 8px; }
:where(.canvas-section) { margin-block-start: 20px; }
:where(.canvas-chart) { min-width: 0; }
:where(svg.canvas-chart, .canvas-chart svg) { display: block; width: 100%; height: var(--canvas-chart-height); }
:where(.canvas-gridline) { stroke: var(--border); stroke-width: 1; }
:where(.canvas-bar) { fill: var(--chart-1, var(--primary)); }
:where(.canvas-line) { fill: none; stroke: var(--canvas-accent, var(--primary)); stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; }
:where(.canvas-area) { fill: var(--canvas-accent, var(--primary)); fill-opacity: 0.12; stroke: none; }
:where(.canvas-accent) { color: var(--canvas-accent, var(--foreground)); }
:where(.canvas-callout) { border-inline-start: 2px solid var(--canvas-accent, var(--primary)); padding-inline-start: 12px; }
:where(.canvas-badge) { display: inline-block; color: var(--muted-foreground); font-size: 11px; font-weight: 500; }
:where(.canvas-lessons) { display: grid; gap: var(--canvas-gap); }
:where(.canvas-lesson > * + *) { margin-block-start: 6px; }
:where(.canvas-positive) { color: var(--success); }
:where(.canvas-warning) { color: var(--warning-text, var(--warning)); }
@media (max-width: 420px) {
  :where(.canvas-columns) { grid-template-columns: 1fr; }
  :where(.canvas-metrics) { grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); }
  :where(.canvas-value) { font-size: 26px; }
}
`;
