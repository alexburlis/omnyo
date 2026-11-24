export const OWNED_ROW_PRESENTATION = '[data-sidebar-row-presentation="owned"]';

const ROW = `.omnyo-sidebar-hover-actions-row:not(${OWNED_ROW_PRESENTATION})`;

const A = "a[data-sidebar-thread-id]";

const IND = "[data-sidebar-thread-trailing-indicator]";

const A_ATTN = `${A}[data-needs-you]:not([data-needs-you="working"]):not([data-needs-you="callback"])`;

const CONTENT = "span:has(> .omnyo-thread-title)";

const NOT_APP_BACKGROUND =
  ":not(:hover):not(.omnyo-sidebar-selected-row):not(.omnyo-sidebar-open-in-split-row):not(:has([data-state=open]))";

export const HIGHLIGHT_CSS = `
:root {
  --needs-you-rail-width: 2px;
  --needs-you-rail: var(--subtle-foreground);
  --needs-you-tint: transparent;
  --needs-you-working-opacity: 0.55;
}

html[data-needs-you-intensity="bold"] {
  --needs-you-rail-width: 4px;
  --needs-you-working-opacity: 0.4;
}

/* Queued first: the per-thread states below override it on the rare row that
   carries both marks. The decorator also clears one before setting the other. */
${ROW}:has(${A}[data-needs-you-queued="waiting"]) {
  --needs-you-rail: var(--subtle-foreground);
  --needs-you-tint: var(--surface-recessed);
}
${ROW}:has(${A}[data-needs-you-queued="failed"]) {
  --needs-you-rail: var(--destructive-text);
  --needs-you-tint: color-mix(in oklab, var(--destructive) 5%, transparent);
}

${ROW}:has(${A}[data-needs-you="unread-success"]) {
  --needs-you-rail: var(--success);
  --needs-you-tint: color-mix(in oklab, var(--success) 10%, transparent);
}
${ROW}:has(${A}[data-needs-you="unread-failed"]) {
  --needs-you-rail: var(--destructive-text);
  --needs-you-tint: var(--surface-destructive);
}
${ROW}:has(${A}[data-needs-you="needs-input"]) {
  --needs-you-rail: var(--attention);
  --needs-you-tint: var(--surface-attention);
}

html[data-needs-you-intensity="bold"] ${ROW}:has(${A}[data-needs-you="unread-success"]) {
  --needs-you-tint: color-mix(in oklab, var(--success) 20%, transparent);
}

html[data-needs-you-intensity="bold"] ${ROW}:has(${A}[data-needs-you="unread-success"]) .omnyo-thread-title,
html[data-needs-you-intensity="bold"] ${ROW}:has(${A}[data-needs-you="unread-failed"]) .omnyo-thread-title {
  font-weight: 600;
}

/* The rail. An inset box-shadow paints above both background-color and
   background-image — sticky selected rows and split rows use a gradient — and
   below every descendant, and it follows the row's own border-radius. It is
   drawn on hovered and selected rows too, so a selected row that needs you
   still reads as selected AND as needing you.

   It is written into Tailwind's own --tw-inset-shadow slot and re-declares the
   full chain, rather than setting box-shadow directly. Omnyo puts its
   drag-to-nest feedback on this exact element with ring utilities
   (ring-sidebar-ring for a valid drop, ring-destructive/60 for a blocked one,
   ring-sidebar-border for unchanged), and .ring-1 resolves through
   --tw-ring-shadow in the same five-slot chain. A bare box-shadow here is
   unlayered, so it would replace that chain outright and erase the only visual
   a blocked nest drop has. All five slots are registered
   "inherits:false; initial-value:0 0 #0000", so naming them is safe even on
   rows carrying no ring. */
${ROW}:has(${A_ATTN}),
${ROW}:has(${A}[data-needs-you-queued]) {
  --tw-inset-shadow: inset var(--needs-you-rail-width) 0 0 0 var(--needs-you-rail);
  box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow),
    var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
}

/* The row tint, only at "bold" intensity, and only while Omnyo is not painting the
   row itself. Stepping aside for hover / selected / open-in-split / open-menu
   keeps Omnyo's own feedback intact instead of replacing it.

   Painted as a background-IMAGE layer, not background-color. A parent thread
   row with children is rendered through Omnyo's SidebarStickyTier, which relies on
   an opaque "bg-sidebar" (background-color: var(--sidebar)) to mask the child
   rows scrolling underneath it while pinned. Every tint token here is a 5-20%
   color-mix against "transparent", so replacing background-color would make a
   pinned parent row see-through and let its own children scroll through its
   title. A gradient layer composites over whatever background-color Omnyo set
   instead of erasing it. This is Omnyo's own technique for sticky selected rows. */
html[data-needs-you-intensity="bold"] ${ROW}:has(${A_ATTN})${NOT_APP_BACKGROUND},
html[data-needs-you-intensity="bold"] ${ROW}:has(${A}[data-needs-you-queued])${NOT_APP_BACKGROUND} {
  background-image: linear-gradient(var(--needs-you-tint), var(--needs-you-tint));
}

/* Omnyo draws "needs input" and both queued glyphs in text-muted-foreground/75 and
   the unread-success dot in bg-muted-foreground/60 — the near-invisible grey
   this plugin exists to fix. Hugeicons paint with currentColor, so setting
   colour is enough for every icon kind; the success dot is a plain <span> and
   needs background-color instead.

   Omnyo only lets another plugin's row status replace its own indicator for kinds
   OTHER than runtime, unread-error and waiting-for-input, so the first two
   colour rules below can never repaint a foreign plugin's glyph.

   unread-success is NOT on that exclusion list, so a foreign row status CAN
   occupy the indicator on a row we marked. Omnyo renders every icon — its own and
   every plugin-declared glyph — through a component that stamps "data-icon",
   while Omnyo's success dot is a plain <span class="size-[5px] rounded-full">
   carrying only aria-label. Excluding [data-icon] therefore hits Omnyo's dot and
   nothing else, instead of painting a green block behind another plugin's
   badge. */
${ROW}:has(${A}[data-needs-you="needs-input"]) ${IND} > *,
${ROW}:has(${A}[data-needs-you="unread-failed"]) ${IND} > *,
${ROW}:has(${A}[data-needs-you-queued]) ${IND} > * {
  color: var(--needs-you-rail);
}

${ROW}:has(${A}[data-needs-you="unread-success"]) ${IND} > span[aria-label]:not([data-icon]) {
  background-color: var(--needs-you-rail);
}

html[data-needs-you-intensity="bold"] ${ROW}:has(${A}[data-needs-you="unread-success"]) ${IND} > span[aria-label]:not([data-icon]) {
  width: 8px;
  height: 8px;
}

/* "Still working" — the one state that wants nothing from you. It gets no rail,
   no tint and no recoloured indicator: it is drawn by taking contrast AWAY, so
   the handful of rows that do want you stand out against the ones that are
   simply busy. Omnyo's own spinner keeps saying what the row is doing.

   Opacity, not a grey colour, because the row's content is a title, a
   cross-project icon and a collapse chevron in three different tokens; fading
   the group keeps their relationships and needs no per-element palette. It is
   applied to the content span only — not the row — so the trailing indicator
   stays crisp and Omnyo's hover/selected background is untouched underneath.

   Like the tint, it steps aside while Omnyo is painting the row itself: the row
   you are hovering, the thread you have open and the row whose menu is open
   read at full strength, so dimming never fights Omnyo's own feedback or makes the
   thread you are reading look disabled. */
${ROW}:has(${A}[data-needs-you="working"])${NOT_APP_BACKGROUND} ${CONTENT} {
  opacity: var(--needs-you-working-opacity);
}

/* A callback remains in progress without claiming the agent is executing.
   Its title keeps full contrast like every other chat that is not running;
   its neutral dashed rail and static host Clock glyph distinguish it from work. */
/* The host already positions rows. Keep its sticky/absolute positioning so
   callback decoration cannot move rows or disable parent-header pinning. */
${ROW}:has(${A}[data-needs-you="callback"])::before {
  content: "";
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  border-left: 2px dashed var(--subtle-foreground);
  pointer-events: none;
}

/* Forced-colors mode (Windows High Contrast and friends). The UA forces
   box-shadow to none and replaces every author colour with a system colour, so
   the rail and the recoloured indicator above both disappear and the plugin
   would silently do nothing. An outline is not a forced property, so it still
   paints: the row keeps a visible marker, drawn inside the row box so it does
   not shift layout. The per-state colours necessarily collapse into one system
   Highlight — forced-colors offers no palette to distinguish four states — so
   this says "this row wants you", and the glyph Omnyo draws says which kind. */
@media (forced-colors: active) {
  ${ROW}:has(${A_ATTN}),
  ${ROW}:has(${A}[data-needs-you-queued]) {
    outline: var(--needs-you-rail-width) solid Highlight;
    outline-offset: calc(-1 * var(--needs-you-rail-width));
  }
}
`;
