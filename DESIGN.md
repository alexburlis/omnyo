# Omnyo design

Omnyo's chrome is achromatic ink over canvas with a few semantic tints. It
should feel like a first-party Apple app running in WebKit: quiet, precise and
fast. This file owns the motion system and the shared component roles.
Colour, typography, radius and row metrics live in [`apps/app/src/components/ui/theme.css`](apps/app/src/components/ui/theme.css),
which is the source of truth for every token named here;
[`design-explorations/_brand.md`](design-explorations/_brand.md) summarises
those visual tokens for explorations.

## Motion

Motion explains what happened. It shows where something came from, where it
went and what caused it. It never decorates, never makes the owner wait and
never competes with the content. When in doubt, use less.

### Principles

- **Physical, not theatrical.** Things move from where they come from: an
  overlay grows out of its trigger, a sheet slides in from its edge, a row
  folds into the space it leaves. Travel is short (4–8 px), scale changes are
  small (0.95–0.98), and nothing spins, flips or zooms from nothing.
- **Springs for travel, curves for fades.** Anything that travels between two
  resting places (panels, disclosures, reorders, morphs) settles on a
  critically damped spring. Fades and colour changes use the Core Animation
  default curve.
- **Quick in, quicker out.** Entrances decelerate and take a little longer;
  exits are shorter and get out of the way. Edge sheets are symmetric.
- **No overshoot on chrome.** Only small controls (press release, switch
  thumb, checkbox mark, copy check) may overshoot, by at most 1%. Nothing
  bounces.
- **Never block.** A chosen action runs immediately; its surface animates
  away afterwards. Input is never held for a transition.
- **Quiet by default.** Anything the owner does many times a minute (list
  hover, selection, typing, streaming, live counters) does not animate. The
  one exception is the fading tail of a streamed reply (see **Streamed reply
  tail** below), which makes text arrive instead of jump.
- **Owner-initiated moments may carry a little more.** When the owner
  deliberately opens, reveals, advances or confirms something (expands a
  group, shows a set of cards, steps a flow forward, saves), the result may
  stagger in, travel along the step axis, draw a confirmation check or lift
  a clickable card. These still use the tokens and owners below, stay short
  (the last staggered item starts within 150 ms), never block input and never
  play on first paint or for changes the system makes on its own.
- **Reduce Motion is a first-class mode.** Travel and scale become a short
  crossfade, layout snaps, loops stop. Spinners keep spinning, because a
  frozen spinner reads as a hang.

### Tokens

Every duration and curve comes from the `--motion-*` tokens in `theme.css`
(`:root`, unlayered so separately built plugin sheets resolve the same values)
and their JavaScript mirrors in
[`packages/shared-ui/src/components/ui/motion.ts`](packages/shared-ui/src/components/ui/motion.ts)
(`MOTION_EASE`, `MOTION_DURATION_MS`, imported as `@omnyo/shared-ui/motion`
in the app and `@/components/ui/motion` in plugins). Literal durations and
`cubic-bezier()` values appear nowhere else.

#### Curves

| Token                    | Utility       | Value                                                       | Use                                                                                                                                                                                                                              |
| ------------------------ | ------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--motion-ease-standard` | default       | `cubic-bezier(0.25, 0.1, 0.25, 1)` (Core Animation default) | Colour, opacity, hover and focus; overlay entrances and in-place exits; reduced-motion crossfades. Plain `transition-*` and `animate-in`/`animate-out` use it.                                                                   |
| `--motion-ease-out`      | `ease-out`    | `cubic-bezier(0, 0, 0.58, 1)`                               | Opacity-led arrival of content in place: streamed blocks, new rows and cards, scrims, the spotlight fade-in.                                                                                                                     |
| `--motion-ease-in`       | `ease-in`     | `cubic-bezier(0.42, 0, 1, 1)`                               | Only exits that travel away along their axis: the launcher's send lift, a notice dismissed off its edge, a queued row leaving toward the thread.                                                                                 |
| `--motion-ease-in-out`   | `ease-in-out` | `cubic-bezier(0.42, 0, 0.58, 1)`                            | Symmetric and looping motion only: pulse, jiggle, hero drift, indeterminate sweep, sparkle. Never for reveals or travel.                                                                                                         |
| `--motion-ease-smooth`   | `ease-smooth` | `linear(…)`: SwiftUI `.smooth` spring, bounce 0             | Travel and layout: sidebar and right-panel slides, every expand and collapse, sortable displacement and drop, FLIP morphs, view transitions, toast stacking, digit rolls. Reaches 90% at half its duration and never overshoots. |
| `--motion-ease-snappy`   | `ease-snappy` | `linear(…)`: SwiftUI `.snappy` spring, bounce 0.15          | Small controls only: press release, switch thumb, checkbox mark, copy-to-check glyph. Peaks at 1.0062. Reduce Motion remaps it to `smooth`.                                                                                      |
| `--motion-ease-sheet`    | `ease-sheet`  | `cubic-bezier(0.32, 0.72, 0, 1)` (iOS sheet)                | Edge sheets and drawers, and settling after a drag, where the steep start continues the finger's velocity.                                                                                                                       |

Both springs are sampled from Apple's spring model (mass 1, stiffness
(2π/d)², damping 4π(1 − bounce)/d) with the CSS duration set to 1.25× the
perceptual duration, so one `linear()` string serves every duration. They need
WebKit 17.2 or later, which every supported client has.

`--motion-ease-panel` and `--motion-ease-spring` are retired aliases of
`smooth` and `snappy`. They stay so that separately built plugins and themes
keep resolving; new code does not use them.

#### Durations

| Token                       | Value  | Use                                                                                                                                                                                                         |
| --------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--motion-duration-fast`    | 150 ms | Hover colour; press-in; every exit (menu, popover, tooltip, dialog, scrim); menu, context-menu and tooltip entrances; reduced-motion crossfades; the shortest drag settle. The Tailwind default transition. |
| `--motion-duration-base`    | 250 ms | Popover, hover-card, dialog and scrim entrances; collapse; press release and switch thumb; sortable displacement and drop; chevrons; arrival fades; small state changes. The `animate-in` default.          |
| `--motion-duration-slow`    | 350 ms | Expand; spotlight rise; FLIP morphs and shared-element travel; larger reveals.                                                                                                                              |
| `--motion-duration-sheet`   | 400 ms | Bottom sheets and compact dialog drawers, both directions.                                                                                                                                                  |
| `--motion-duration-drawer`  | 267 ms | Compact side drawers (sidebar, secondary-panel shelf) and the page inset that moves with them; the ceiling of their drag settle.                                                                            |
| `--motion-duration-sidebar` | 60 ms  | Desktop left sidebar show and hide.                                                                                                                                                                         |
| `--motion-duration-panel`   | 90 ms  | Desktop right panel show and hide, single thread and split workspace.                                                                                                                                       |
| `--motion-duration-stagger` | 30 ms  | The step between staggered items. The step shrinks for long groups so the last item always starts within `fast` (150 ms).                                                                                   |

The desktop sidebar and right panel are deliberately near-instant. Their
layout snaps once and only the surface slides on the compositor, so nothing
that measures the thread runs on each frame; a longer slide would expose the
snapped layout underneath. The right panel is wider, so it travels slightly
longer. Do not slow these down without moving the content with the surface.

Named loop and highlight constants are the only other literal timings, and
each lives with its keyframes: pulse 2 s, ping 1 s, ultracode shimmer 3 s and
sparkle 1.8 s, search flash 1.6 s, count flash 1.2 s, hero drift, nav-rail
jiggle 0.3 s, caret blink, the shine sweep, and the working orb's breathe
2 s and 2.4 s, ping 2 s, ring spin 0.9 s (1.8 s while thinking), halo 2.4 s
(3.2 s while thinking) and tab sheen 3.2 s. The first-run logo intro
(`onboarding-intro.css`, `.omnyo-intro`) is a one-off brand choreography that
keeps its own timeline and expo curve with its keyframes.

### Roles

| Role                                 | Examples                                                                                             | Enter                                                                                                                                                                                                                           | Exit                                                                                                                                           | Reduce Motion                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Control hover**                    | Button fill, inputs, chips, toolbar icons                                                            | Colour over `fast` on `standard` (`CONTROL_HOVER_TRANSITION`)                                                                                                                                                                   | Same                                                                                                                                           | Unchanged (colour only)                                          |
| **Press**                            | Buttons, rail tiles, send/stop, pills                                                                | `:active` scales to 0.97 over `fast` on `snappy` (`CONTROL_PRESS_TRANSITION` + `CONTROL_PRESS_FEEDBACK`)                                                                                                                        | Releases over `base` on `snappy`; a trigger stays still while its menu is open                                                                 | No scale; colour remains                                         |
| **List row hover and selection**     | Sidebar rows and their time/actions swap, menu items, select items, table and settings rows          | Instant (`LIST_HOVER_TRANSITION`, which also cancels press scale on rows)                                                                                                                                                       | Instant                                                                                                                                        | Same                                                             |
| **Small control state**              | Switch thumb, checkbox mark, radio dot, copy-to-check                                                | Thumb or mark travels over `base` on `snappy`; fill over `base`                                                                                                                                                                 | Same                                                                                                                                           | Settles on `smooth`                                              |
| **Disclosure chevron**               | Tool rows, accordions, info sections, change groups                                                  | One rotating chevron over `base` on `smooth` (`DISCLOSURE_CHEVRON_TRANSITION`); never swap icons                                                                                                                                | Same                                                                                                                                           | Instant                                                          |
| **Expand and collapse**              | Accordion, Collapsible, `HeightTransition`, `ExpandablePanel`, composer banner stack, workflow cards | Height or grid rows plus opacity over `slow` on `smooth` (`getDisclosureRevealClass`, `getDisclosureDurationMs`, collapsible keyframes)                                                                                         | Over `base` on `smooth`                                                                                                                        | Size snaps; opacity crossfades                                   |
| **Menus**                            | Dropdown root, select, menubar                                                                       | Fade, scale from 0.97 and 4 px from the trigger side over `fast`, from the Radix transform origin (`FLOATING_MENU_MOTION`)                                                                                                      | Fade over `fast`                                                                                                                               | Opacity only                                                     |
| **Context menus and submenus**       | Context menu at the pointer, submenus                                                                | Fade over `fast` (`FLOATING_FADE_MOTION`)                                                                                                                                                                                       | Fade over `fast`                                                                                                                               | Same                                                             |
| **Tooltips**                         | Shared Tooltip, TOC markers                                                                          | After the open delay: fade, 0.97 and 4 px over `fast`. Sweeping across a toolbar (instant open) shows with no animation (`TOOLTIP_MOTION`)                                                                                      | Fade over `fast`                                                                                                                               | Opacity only                                                     |
| **Popovers and anchored panels**     | Popover, hover card, selection menu, TOC outline, typeahead, notification center                     | Fade, scale from 0.95 and 8 px from the trigger side over `base` (`FLOATING_POPOVER_MOTION`)                                                                                                                                    | Fade and 0.95 over `fast`                                                                                                                      | Opacity only                                                     |
| **Dialogs and scrims**               | Dialog, AlertDialog, confirmations, blocking update overlays                                         | Scrim fades over `base`; content fades and scales from 0.95 over `base` (`MODAL_OVERLAY_MOTION`, `MODAL_CONTENT_MOTION`); content keeps its last children while closing                                                         | Over `fast`                                                                                                                                    | Crossfade                                                        |
| **Spotlight**                        | Command palette, ⌘N launcher, plugin command dialog                                                  | Fade over `fast` on `ease-out` while rising 8 px from 0.97 over `slow` on `smooth`; backdrop over `base` (`.omnyo-spotlight`)                                                                                                   | Dismiss: fade, 4 px and 0.98 over `fast`. Send: lifts 12 px over `fast` on `ease-in`                                                           | Opacity over `fast`                                              |
| **Bottom sheets and dialog drawers** | Compact Dialog, Popover, Menu and Select drawers                                                     | Slide from the edge over `sheet` on `sheet`, backdrop on the same timing; the first open slides from fully off-screen with its real height                                                                                      | Same curve and duration                                                                                                                        | Panel and backdrop crossfade over `fast`                         |
| **Compact side drawers**             | Compact sidebar and page inset, secondary-panel shelf                                                | Slide over `drawer` on `sheet`                                                                                                                                                                                                  | Same                                                                                                                                           | Instant; the layout snaps                                        |
| **Gesture release**                  | Sidebar swipe, shelf dismiss, sheet handle drag, mobile tab pager                                    | Tracks the finger 1:1 with no transition                                                                                                                                                                                        | Settles the remaining distance over `getDragSettleMs(remaining, reduced, max)` on `sheet` (`dragSettleTransition`); timers read the same value | Tracking unchanged; settle is instant                            |
| **Desktop chrome toggles**           | Left sidebar, right panel, resize-handle fade                                                        | Layout snaps once, then the surface slides with `translate` over `sidebar`/`panel` on `smooth`; nothing moves on first paint or thread switch                                                                                   | Same slide, then `visibility: hidden`                                                                                                          | Instant                                                          |
| **Live resize**                      | Panel, split and sidebar resize handles                                                              | No transition while dragging                                                                                                                                                                                                    | Detents snap; the split drop overlay fades over `fast`                                                                                         | Overlay appears instantly                                        |
| **Sortable reorder**                 | Sidebar sections and rows, panel tabs, queued messages, settings rows                                | Neighbours shift over `base` on `smooth` (`SORTABLE_TRANSITION`)                                                                                                                                                                | The drag overlay drops over `base` on `smooth` (`getSortableDropAnimation`)                                                                    | No displacement, no drop animation (`getSortableTransition`)     |
| **Toasts**                           | Host Sonner toaster; plugin `toast()`                                                                | Sonner's 400 ms; travel and height on `smooth`, opacity on `standard`. Archive and shelve toasts are instant (`omnyo-instant-toast`)                                                                                            | Same                                                                                                                                           | Sonner's reduced handling                                        |
| **Arrival of new content**           | Streamed blocks, queued cards, handoff and starting-chat rows                                        | Opacity with ≤ 6 px rise over `base` on `ease-out`; streamed blocks add a 3 px blur. Never on first paint, history load, bulk insert or per token, except the streamed reply tail                                               | See removal                                                                                                                                    | None                                                             |
| **Streamed reply tail**              | Assistant reply text while it streams; not tool, command or thinking output                          | The newest 16 words rise from 8% to full opacity over `base` on a cubic ease-out, staggered by arrival; one rAF sets inline opacity on those word spans only, and settled words carry no spans                                  | None; the reply settles to plain text when streaming ends                                                                                      | Words appear at full opacity                                     |
| **Staggered arrival**                | Cards or rows the owner just revealed: a section expanded, templates shown                           | Each item fades and rises 6 px over `base` on `ease-out`, delayed by index × min(`stagger`, `fast` ÷ (n − 1)) (`getStaggerItemProps`, `.omnyo-stagger-item`); gate it with `useChangedSinceMount` so first paint never staggers | —                                                                                                                                              | Items appear at once                                             |
| **Step and view transition**         | Multi-step flows, a surface swapping between views                                                   | The new view fades in over `base` on `ease-out` while travelling 8 px along the step direction over `slow` on `smooth` (`StepTransition`, `.omnyo-step-enter`)                                                                  | The old view fades over `fast` while moving 4 px the other way on `ease-in` (`.omnyo-step-exit`); it never takes input                         | Crossfade over `fast`                                            |
| **Success confirmation**             | A completed step, a saved form                                                                       | The check draws over `base` on `snappy` after a third of `fast`; its badge scales from 0.6 on `snappy` (`CheckMark`, `SuccessCheck`)                                                                                            | —                                                                                                                                              | The check appears already drawn                                  |
| **Clickable card hover**             | Interactive cards and template tiles; never list rows                                                | Lifts 1 px over `base` on `smooth` while a pseudo-element shadow fades in over `base` (`CARD_LIFT_CLASS`, `Card variant="interactive"`); compositor only                                                                        | Same; `:active` settles back over `fast`                                                                                                       | No lift; the shadow still fades                                  |
| **Progress fill**                    | Step connectors, phase meters, `Progress`                                                            | The fill scales along X over `slow` on `smooth` (`PROGRESS_FILL_TRANSITION`)                                                                                                                                                    | —                                                                                                                                              | Snaps                                                            |
| **Removal and fold**                 | Queued surface exit, notice leave                                                                    | —                                                                                                                                                                                                                               | Fades over `fast`, then height and margin collapse over `base` on `smooth`                                                                     | Removed instantly                                                |
| **Counters**                         | Queue count                                                                                          | Digits roll over `base` on `smooth`                                                                                                                                                                                             | Old digit rolls out                                                                                                                            | Fade over `fast`. Live timers and elapsed counters never animate |
| **Highlight flash**                  | Search and jump reveal, queue count flash                                                            | Background decays over its named constant on `standard`                                                                                                                                                                         | Removed on `animationend`                                                                                                                      | Search flash skipped                                             |
| **Morphs and view transitions**      | Home-send travel, thread-companion morph                                                             | `slow` on `smooth`; WAAPI resolves curves with `resolveMotionEase`                                                                                                                                                              | Old snapshot crossfades                                                                                                                        | Crossfade over `fast`, or skipped                                |
| **Programmatic scroll**              | Jump to latest, unread pills, tab strip chevrons, search reveal                                      | Native smooth scrolling; streaming follow is instant or the bottom-anchored rAF follow                                                                                                                                          | —                                                                                                                                              | `behavior: "auto"`                                               |
| **Ambient loops**                    | Running dots, skeleton pulse, shimmer, ultracode, hero drift                                         | Only while the state they describe is live; paused when hidden                                                                                                                                                                  | Stops with the state                                                                                                                           | Stopped, with a static fallback                                  |
| **Spinners and progress**            | `animate-spin`, status glyphs, route bar, loading bars                                               | Spinners and determinate progress are linear; the indeterminate sweep translates on the compositor                                                                                                                              | Bars fade out over `fast` on completion                                                                                                        | Spinners keep spinning; the sweep becomes a static fill          |
| **Lightbox and zoom**                | Image lightbox, zoomable image                                                                       | Fade over `base`, image from 0.97; stepping crossfades over `fast`; discrete zoom over `base` on `smooth`                                                                                                                       | Fade over `fast`                                                                                                                               | Crossfade; zoom steps instant                                    |
| **Loading reveal**                   | `DelayedLoading`, skeletons, lazy row placeholders                                                   | Appear only after the reveal delay, then fade over `fast`                                                                                                                                                                       | Content replaces them with no transition                                                                                                       | Fade allowed; pulse stops                                        |
| **Charts and meters**                | Usage charts, meters, context-window ring                                                            | No animation on first paint or refresh; a per-turn ring change may move over `slow` on `smooth`                                                                                                                                 | —                                                                                                                                              | None                                                             |

### Where nothing animates

- First paint, route load, history or bulk load, and thread switches (the
  desktop panels gate their transitions behind two frames).
- Chat lifecycle: archiving, shelving, Undo, and status changes to running,
  waiting, finished or ready to archive. The pane switches, rows move and
  status glyphs swap in the same frame.
- Anything per keystroke or per streamed token, live counters, timers and
  elapsed times, running-status badges and counts. The streamed reply tail
  is the only per-token exception.
- List and menu hover, selection and keyboard focus movement in lists.
- Errors, validation messages and inline alerts: they appear at once.
- Width, padding, margin, `left`, `flex-grow` or `flex-basis` of chrome
  (sidebar, panels, split panes, shelf, reserves): these snap.
- Blur and `backdrop-filter` changes, z-depth, and colour cycling.
- Text content changes, except digit rolls on counts the owner just changed.
- Lists and cards present on first paint, and anything the system changes by
  itself: a phase completing, a server stopping or a wait resolving never
  staggers, travels or draws a check.

### Implementation rules

- **One owner per pattern.** Use the shared helpers in `motion.ts`, the
  Radix keyframes in `theme.css` and the named classes in `app.css`; delete
  local copies.

  | Pattern                         | Owner                                                                                                                                          |
  | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
  | Control hover and press         | `CONTROL_HOVER_TRANSITION`, `CONTROL_PRESS_TRANSITION`, `CONTROL_PRESS_FEEDBACK`                                                               |
  | Rows                            | `LIST_HOVER_TRANSITION`                                                                                                                        |
  | Chevrons                        | `DISCLOSURE_CHEVRON_TRANSITION`                                                                                                                |
  | Sliding segmented indicator     | `SegmentedControl`, `SEGMENTED_INDICATOR_TRANSITION` (one indicator translates between equal segments; segments never animate their own fill)  |
  | Staggered arrival               | `getStaggerItemProps`, `getStaggerItemStyle`, `getStaggerDelayMs`, `STAGGER_ITEM_CLASS`, `useChangedSinceMount`                                |
  | Step and view transitions       | `StepTransition`, `STEP_ENTER_CLASS`, `STEP_EXIT_CLASS`                                                                                        |
  | Success confirmation            | `CheckMark`, `SuccessCheck`, `SUCCESS_CHECK_DRAW_CLASS`, `SUCCESS_CHECK_BADGE_CLASS`                                                           |
  | Clickable card hover            | `CARD_LIFT_CLASS`, `Card variant="interactive"`                                                                                                |
  | Progress fills                  | `PROGRESS_FILL_TRANSITION`, `Progress`, `StepIndicator`, `WorkflowPhaseStrip`                                                                  |
  | Rows revealed by Show more      | `REVEALED_CONTENT_MOTION`                                                                                                                      |
  | In-flow disclosure              | `getDisclosureRevealClass`, `getDisclosureDurationMs`, `getDisclosureDurationClass`, `HeightTransition` for measured content                   |
  | Radix Collapsible and Accordion | `COLLAPSIBLE_CONTENT_MOTION`, `animate-collapsible-*`, `animate-accordion-*`                                                                   |
  | Overlays                        | `FLOATING_MENU_MOTION`, `FLOATING_POPOVER_MOTION`, `FLOATING_FADE_MOTION`, `TOOLTIP_MOTION`, `MODAL_OVERLAY_MOTION`, `MODAL_CONTENT_MOTION`    |
  | dnd-kit                         | `SORTABLE_TRANSITION`, `getSortableTransition`, `getSortableDropAnimation` (resolves the curve for dnd-kit's WAAPI drop), `useSidebarSortable` |
  | Drags                           | `getDragSettleMs`, `dragSettleTransition`                                                                                                      |
  | Transition fallback timers      | `TRANSITION_FALLBACK_SLACK_MS`                                                                                                                 |
  | WAAPI and canvas                | `resolveMotionEase`                                                                                                                            |
  | Reduced motion in JavaScript    | `prefersReducedMotion()`, `usePrefersReducedMotion()`                                                                                          |

- **Tokens only.** Set durations with `duration-(--motion-duration-*)` or
  `MOTION_DURATION_MS`, and curves with the `ease-*` utilities,
  `ease-(--motion-ease-*)` or `MOTION_EASE`. Every JavaScript timer coupled to
  an animation reads the same constant and is 0 under Reduce Motion.
- **Compositor first.** Animate `transform`, `translate`, `scale` and
  `opacity`. Height and grid rows animate only through the disclosure owners.
  Name the transitioned properties; never `transition-all` or a bare
  `transition`. Apply `will-change` only while open or dragging.
- **Overlays grow from their trigger.** Use the Radix
  `--radix-*-transform-origin` (the shared primitives set it) and slide from
  the trigger side.
- **Keep content during exits.** `DialogContent` retains its last children
  while closing. Do not gate Popover or DropdownMenu children on `open`;
  reset internal view state when the surface opens.
- **Rows versus blocks.** Affordances revealed by hovering a row in a list
  appear instantly. Affordances revealed by hovering a single content block
  (a message's action bar, an image caption) fade over `fast`.
- **Reduce Motion in CSS.** `animate-in` and `animate-out` already crossfade
  through the theme keyframes, so do not add `motion-reduce:animate-none` to
  them. Stop loops with `motion-reduce:animate-none` and a static fallback.
  Never add it to a spinner.
- **Reduce Motion in JavaScript.** Read it only through
  `prefersReducedMotion()` or `usePrefersReducedMotion()`; never inline a
  `matchMedia` string. `MOTION_EASE` values are `var()` strings, which WAAPI
  cannot parse: resolve them with `resolveMotionEase(name)` and skip the
  animation when it returns an empty string.
- **Plugins** use the same tokens and helpers through
  `@/components/ui/motion` and the host keyframes. They never redefine the
  keyframes or hardcode timings.

### Guards

- `apps/app/src/components/ui/theme.test.ts` keeps the JavaScript mirrors equal
  to the CSS tokens, the springs within their overshoot limits, the retired
  aliases resolving and the reduced-motion keyframes opacity-only.
- `apps/app/src/components/ui/motion-literals.test.ts` fails on literal
  durations, literal curves, Tailwind numeric `duration-*` classes and
  `transition-all` in app source.
- Plugin authors read the same contract in
  `plugins/omnyo-guide/skills/omnyo-cli/references/theming.md`.

## Components

Shared components live in `packages/shared-ui/src/components/ui` and are
imported as `@omnyo/shared-ui/<name>` in the app and `@/components/ui/<name>`
in plugins. Separately built plugins copy them from
`packages/plugin-registry/r/<name>.json`. Reach for these before building a
local variant.

| Need                                | Use                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The one main action on a surface    | `Button` (default). It is the only filled high-contrast control on the surface.                                                                  |
| Alternatives and cancel             | `Button variant="outline"` or `"ghost"`; `"secondary"` for a neutral filled button.                                                              |
| Actions inside a list row           | `Button size="xs" variant="soft"` (Restart, Open, Cancel wait). Use `"ghost"` only for a tertiary action beside a soft one. Never bare text.     |
| Icon-only actions                   | `size="icon-xs"` or `"icon-sm"` with an `aria-label`.                                                                                            |
| Raised, sunken and clickable groups | `Card` with `variant` `default`, `recessed`, `interactive` or `flat`.                                                                            |
| “Thing + state + meta + actions”    | `StatusList` and `StatusRow` with a `StatusTone`; `StatusDot` and `StatusBadge` on their own. The error line sits under the title, never inline. |
| A titled group that can fold        | `CollapsibleSection` (or `CollapsibleSectionHeader` around your own body). The caller owns and remembers `open`.                                 |
| A small glyph or count with meaning | `MetaChip` with a `description`; the description is its tooltip and accessible name, so no icon is left unexplained.                             |
| Choosing between two to five views  | `SegmentedControl`.                                                                                                                              |
| Multi-step flows                    | `StepIndicator` above the flow and `StepTransition` around the step body.                                                                        |
| Picking a file                      | `FileDropZone`; never a raw `<input type="file">`.                                                                                               |
| Keyboard focus                      | `FOCUS_RING_CLASS` on controls, `INSET_FOCUS_RING_CLASS` inside tight tracks, `FIELD_FOCUS_RING_CLASS` on inputs.                                |

Secondary text uses `text-muted-foreground` or `text-subtle-foreground` at
full strength. Opacity modifiers on text tokens (`text-subtle-foreground/75`)
fall below the WCAG AA floor and are not used for text; they remain fine on
icons, which need 3:1.
