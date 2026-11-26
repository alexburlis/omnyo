---
name: audit-codebase-simplification
description: >
  Audit a codebase for dead code and high-value refactoring, simplification,
  and deduplication opportunities. Produce an evidence-backed, highest-impact-first
  inventory and self-contained implementation plans that preserve features,
  observable behavior, exact UI/UX, and performance. Keep incidental bugs,
  performance issues, and other concerns in a separate P0-P3 backlog. Use for
  exhaustive codebase sweeps, cleanup assessments, complexity-reduction roadmaps,
  and refactoring plans when the requested deliverable is analysis, not code changes.
license: MIT
---

# Audit codebase simplification

Find the largest defensible reductions in maintained machinery, duplicated knowledge,
state coordination, and change effort. Produce plans that another agent can execute
without this conversation or a second architecture-discovery exercise.

**Deliver an audit and implementation plans. Do not implement them.** Write only the
requested audit artifacts. Do not alter application code, dependencies, tests,
snapshots, configuration, or data; do not commit, deploy, or open external tickets.
If implementation is also requested, finish the audit first and treat implementation
as a separate, explicitly scoped phase under the user's existing authorization.

## 1. Establish scope and preservation requirements

Read applicable repository instructions, manifests, architecture notes, build/release
configuration, and CI. Identify the requested repository, revision, release, and
subsystems. Interpret a label such as “2.0” from actual repository evidence; do not
assume it is a branch name. Otherwise audit the current checkout. Record the commit,
branch, relevant uncommitted changes, date, and boundaries of the inspected snapshot.
Preserve unrelated work; ask only when a material ambiguity cannot be resolved.

Determine supported platforms, build variants, configurations, public consumers,
plugins, integrations, persisted formats, and upgrade paths. Distinguish documented
support from assumptions. Historical code is not automatically obsolete.

Treat these as preservation requirements for every proposed refactor:

| Surface                 | Preserve                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Features and interfaces | All supported capabilities, defaults, APIs, CLI behavior, integrations, permissions, and compatibility contracts.                                                                                                  |
| Data and effects        | Stored formats, migrations, serialization, ordering, side effects, transactions, error behavior, retries, cancellation, cleanup, and lifecycle semantics.                                                          |
| UI and UX               | Layout, typography, colors, spacing, assets, copy, animations, focus, shortcuts, navigation, accessibility, and interaction behavior in relevant loading, empty, error, disabled, responsive, and platform states. |
| Performance             | Relevant latency, throughput, memory, startup, responsiveness, allocations, I/O, bundle size, and operational cost. Preserve required timing semantics even when execution becomes faster.                         |
| Operability             | Useful diagnostics, logging contracts, observability, recovery, and supported administrative or maintenance workflows.                                                                                             |

Record current bugs separately. Do not quietly correct behavior inside a refactor.
Do not propose removing a supported capability because it is rarely used, inconvenient,
or expensive to preserve. Removing verified dead machinery is in scope; feature
retirement requires a separate decision.

Use existing tools and commands. Start file and text discovery with `rg --files`
and `rg` where available. Treat commands that regenerate files, fix lint, update
snapshots, install dependencies, or contact live systems as mutations, not inspection.
Use isolated disposable outputs when needed; report tool-induced changes and do not
overwrite user work. Never expose secrets in evidence or reports.

## 2. Map the whole codebase before selecting targets

Create a coverage ledger for first-party apps, services, packages, native/platform
code, shared modules, tests/fixtures, scripts, build/release tooling, configuration,
and assets. Identify generated/vendor/build output separately; inspect its ownership
and generation rules without counting its volume as handwritten complexity.

For each area, record its entry points, responsibilities, important dependencies,
verification commands, inspection depth, and status: reviewed, partially reviewed,
excluded with reason, or blocked with the missing prerequisite. Count coverage only
against a defined inventory. Reading a file list is not an implementation review.

Trace representative user journeys and execution paths through real callers,
implementations, state owners, persistence, and external boundaries. Inspect enough
source to understand the mechanism and its consumers before recommending removal.
Include cross-package relationships, not just directory-local smells.

Run practical existing baseline checks when they materially inform the audit. Record
exact commands, working directory, environment/build mode, and outcomes: passed,
failed, blocked, or not run. Separate pre-existing failures from unknowns. Inspect
relevant tests even when the full application cannot run in this environment.

Use size, dependency graphs, duplicate detection, compiler diagnostics, and change
history to find leads. Distinguish semantic churn from generated, formatting, or
migration churn. Tool output is evidence to investigate, not a verdict.

For large repositories, divide independent areas among agents when available. Give
each the same snapshot, constraints, coverage responsibility, and output format.
Require evidence, consumers, counterevidence, and explicit gaps. Reconcile duplicate
findings and inspect cross-boundary effects centrally; delegation is not verification.

## 3. Sweep for removable mechanisms

Investigate these categories wherever applicable:

| Category                     | Look for                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead or superseded machinery | Unreachable implementations, abandoned pipelines, obsolete flags, unused assets/dependencies/exports, and supporting code retained after its owner disappeared.       |
| Duplicate knowledge          | Independently maintained business rules, validation, schemas, settings, permissions, command metadata, mappings, or parallel workflows.                               |
| State coordination           | Competing sources of truth, mirrored state, redundant caches, synchronization effects, contradictory flags, and unclear lifecycle/resource ownership.                 |
| Unnecessary abstraction      | Pass-through layers, unused extension points, factories/registries with no current purpose, generic frameworks supporting one real case, and excessive configuration. |
| Coupling and boundaries      | Dependency cycles, leaked internals, unrelated responsibilities requiring coordinated edits, and small changes spread across many modules.                            |
| Data and control flow        | Repeated conversions, redundant intermediate representations, scattered orchestration, overlapping pipelines, and avoidable branching or dispatch.                    |
| Supporting infrastructure    | Duplicate build steps, redundant dependencies, obsolete fixtures, needlessly complex test setup, and generated output whose source can be simplified.                 |

Prefer deleting an unnecessary responsibility, consolidating shared knowledge, deriving
truly redundant state, collapsing a purposeless layer, or specializing unused
generality. Introduce an abstraction only when its concrete net benefit beats the
simpler alternatives, including retaining explicit code.

Ask for every candidate:

- What maintained mechanism or recurring coordination burden disappears?
- What current requirement explains why this code exists?
- Which real change becomes easier, and which files or concepts no longer change together?
- What new coupling, indirection, computation, configuration, or dependency replaces it?
- Could a smaller local change deliver most of the benefit?

Do not equate fewer lines with better design. Reject code golf, opaque helpers,
renaming campaigns, mechanical file splitting, architecture fashion, and speculative
future-proofing as high-potential findings without a demonstrated current benefit.
Preserve boundaries that enforce security, platform behavior, resource ownership,
or independently varying policy. A wrapper or cache may be necessary.

For deduplication, establish shared meaning and invariants, not merely similar text.
Check ownership, error semantics, change cadence, and valid reasons for divergence.
Keep separate policies separate. If a shared helper needs caller-specific switches
and branches, consider inlining or retaining the implementations. Never merge client
and server validation in a way that removes a trust-boundary check.

For state simplification, trace updates, subscriptions, scheduling, cancellation,
re-entry, and out-of-order completion. Deriving a value may increase work or change
when observers see it. Removing a cache requires an explicit performance argument.

### Dead-code evidence standard

For every deletion candidate, give a reachability argument from supported entry
points and check the applicable non-obvious consumers:

- Public/package exports and external clients, including older supported clients.
- Dynamic imports, reflection, runtime registration, dependency injection, plugin
  discovery, naming conventions, native/FFI entry points, and import side effects.
- Routes, templates, selectors, serialized identifiers, localization keys, and assets
  referenced through strings, configuration, or generated manifests.
- Feature flags, remote configuration, platform/build variants, background jobs,
  scripts, CI/release tooling, maintenance and recovery workflows.
- Persisted data, applied migration history, upgrade paths, and compatibility shims.

Search beyond the default ignore scope when relevant, without indiscriminately
scanning secrets or huge generated trees. Trace orphaned groups: internal references
within a disconnected component do not establish a supported caller. Conversely,
zero textual references, old timestamps, passing tests, or absent telemetry do not
prove that code is dead. Lack of local use does not prove lack of external use.

Classify each candidate as **verified removable within the inspected support scope**,
**conditional**, or **retain**, and state why. For conditional cases, name the precise
missing evidence and how to obtain it. Do not require speculative proof about every
possible future user; establish the actual support boundary. Keep applied migrations
unless repository-specific history/upgrade policy proves their removal safe.

## 4. Validate, estimate, and rank opportunities

Group symptoms with the same root cause into one opportunity; split independently
executable transformations. Give opportunities stable IDs such as `RF-001` that do
not change when their rank changes. Separate verified facts, supported inferences,
and implementation projections. Investigate counterevidence before promotion.

For each opportunity, estimate net benefit with a stated basis and confidence:

- **Maintained code:** a range for handwritten production lines removed and added,
  and resulting net reduction where reasonably estimable. State the counting scope.
  Report tests, configuration, documentation, generated code, and assets separately.
  Moved code, formatting changes, and shifted dependency code are not deleted complexity.
- **Mechanisms:** before/after owners, duplicated rule definitions, state stores,
  synchronization paths, layers, conversions, dependency edges/cycles, or packages.
  Use only measures that describe this candidate's actual burden.
- **Maintenance:** explain an existing kind of change before and after, including
  coordinated edit sites and concepts a maintainer must understand. Label projected
  counts. Do not invent percentage maintainability, productivity, or token gains.
- **Effort:** give a reasoned range for implementation and verification; expose major
  assumptions, platform needs, discovery gaps, and uncertainty. Use coarse sizing
  when time estimates would be fictitious.
- **Risk:** name the affected contracts, blast radius, migration/rollback complexity,
  and likely regression modes. Large deletions can be safe; tiny timing edits can be risky.
- **Performance:** identify likely neutral, beneficial, or uncertain effects and the
  affected metric. Any improvement is a hypothesis until measured on representative
  workloads. Fewer source lines do not imply faster execution.

Rank by the largest evidence-supported, durable reduction in maintenance burden,
accounting for confidence, effort, and regression risk. Explain tradeoffs in plain
language; do not hide judgment behind an arbitrary numerical score. Keep potential,
confidence, and execution readiness distinct. A promising conditional candidate may
rank highly, but must not appear ready to delete.

Show the highest-potential items first. Also retain every other substantiated
material opportunity discovered in scope; do not stop at an arbitrary top five or
ten. Avoid inflating the inventory with cosmetic or speculative micro-findings.
Record important rejected candidates and their reasons so later agents do not repeat
the same investigation. A justified empty opportunity list is valid.

Identify prerequisites, mutually exclusive alternatives, overlapping removal counts,
and changes that invalidate other plans. Count shared savings once. Give the preferred
execution sequence separately from the impact ranking; prerequisites can come first
without being the highest-value work themselves.

## 5. Write a self-contained execution card for every opportunity

Use this structure for each `RF` item. Scale detail to complexity, but leave no
substantive design choice hidden behind “refactor this,” “update callers,” or “test it.”
A conditional item needs a concrete investigation gate before its implementation steps.

### RF-<id> — <specific mechanism to remove or simplify>

**Rank and disposition**
State potential, confidence, readiness, effort, risk, prerequisites, related findings,
and overlapping or alternative opportunities. Explain why this deserves its rank.

**Context and evidence**
Explain the subsystem in plain language. Record the snapshot and relevant support
scope. Cite repository-relative paths, exact symbols, important callers/consumers,
configuration, and relevant tests; add line anchors when useful, but not as the only
locator. Include decisive search scopes, tool results, and counterevidence. Distinguish
observed facts from assumptions. Explain the maintenance cost of the current design.

**Proposed end state and preservation argument**
Describe what disappears, what remains, the canonical owner, intended dependency and
data flow, and why this is the simplest sufficient option. Name exact affected
contracts and UI states. Explain how current semantics survive; document intentional
retention of known problematic behavior and link the separate issue. State non-goals.
For a deletion, include its reachability proof and remaining uncertainty.

**Expected gain and cost**
Give the justified before/after estimates from section 4, including additions and
tradeoffs. Explain the causal link between the change and easier maintenance. Mark
unknowns as unknown. Do not present projections as measurements.

**Execution steps**

1. Reconfirm the snapshot, support assumptions, source anchors, dependencies, and
   baseline. State which discoveries invalidate this plan and require re-planning.
2. Establish only the missing behavioral evidence needed for this change. Name
   fixtures, representative inputs, relevant UI states, and meaningful checks.
3. Describe ordered edits by file and symbol: what to remove, inline, consolidate,
   or derive; where the surviving logic belongs; and how each consumer changes.
   Include signatures, data shapes, or pseudocode where semantics would be ambiguous.
4. Divide larger changes into coherent, working checkpoints. Keep mechanical moves
   distinguishable from semantic restructuring. Name verification after each risky
   checkpoint. Avoid maintaining parallel implementations without a removal condition.
5. Remove superseded support machinery: exports, registration, configuration,
   dependencies, assets, fixtures, comments, and documentation where truly obsolete.
   Change generated artifacts through their source. Preserve unique test obligations.
6. Run the specified verification and inspect the complete diff for unrelated changes
   and leftover old/new paths. Recount actual reductions against the same baseline.

**Verification and acceptance criteria**
Give exact repository-supported commands and working directories when known, plus
expected outcomes. Label unverified commands; never invent script names. Explain how
to obtain unavailable platforms, fixtures, or benchmark prerequisites. Specify:

- Behavior/contract checks that can catch the realistic regression, including relevant
  errors, serialization, side effects, ordering, and lifecycle/concurrency cases.
- Targeted visual and interaction comparisons for affected UI. Preserve the baseline;
  do not bless changed snapshots to make the refactor pass. A single screenshot does
  not verify focus, accessibility, timing, or navigation.
- Relevant before/after performance comparisons under comparable environments, builds,
  data, and workloads. Use existing budgets and distinguish measurement noise from
  regression. If no credible baseline exists, require one before accepting a sensitive
  change. Do not invent a regression allowance or claim neutrality without evidence.
- Structural completion: superseded mechanisms and callers are gone, ownership is
  unambiguous, and the promised maintenance reduction is actually achieved.

Reuse existing verification. Recommend new characterization or regression tests only
for meaningful uncovered risks; do not require scaffolding for trivial mechanical
changes. Do not weaken assertions, remove distinct coverage, or rewrite expected
behavior to validate the replacement against itself. Keep an independent baseline.

**Rollback and stop conditions**
Describe a reversible change boundary and any data/compatibility implications.
Name concrete stop conditions such as a live external consumer, a supported variant
that needs the old path, a contract mismatch, or a measured performance regression.
Explain the next investigation or safer smaller alternative. Do not default to a
destructive reset or undo unrelated changes.

## 6. Maintain a separate incidental-findings backlog

Put bugs, security/reliability concerns, standalone performance optimizations, and
other issues outside the simplification plans. Assign stable IDs such as `ISS-001`.
Do not treat a discovery as permission to fix it or silently enlarge a refactor.

Use the project's existing P-level definitions if available and reproduce them.
Otherwise use:

| Priority | Meaning                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0       | Immediate response: confirmed active or imminent severe impact, such as broad outage, unrecoverable data loss, or actively exposed critical compromise. |
| P1       | Urgent: high-impact broken core behavior, serious reliability/security exposure, or a severe performance defect with credible reachability.             |
| P2       | Normal: bounded correctness, reliability, accessibility, or performance problems with meaningful impact and tolerable workarounds or limited exposure.  |
| P3       | Low: minor impact, limited edge cases, or low-value polish/maintenance concerns.                                                                        |

Assess priority using impact, exposure/likelihood, and urgency; state evidence
confidence separately. Mark unconfirmed severity provisional. A hypothesis is not a
confirmed bug, and hypothetical worst-case impact alone does not establish P0/P1.
Put feature ideas and preference changes in a clearly labeled suggestions subsection;
do not present them as defects. Surface a substantiated urgent issue promptly while
keeping the remaining audit moving where feasible.

For every issue include: priority and rationale; observed or suspected status;
affected files/symbols and users/configurations; expected versus actual behavior and
the basis for the expectation; reproduction or confirmation steps; likely root cause;
proposed fix; risks/dependencies; verification; and relevant `RF` links. Do not invent
a reproducer or a root cause that was not established.

A refactor's intrinsic performance effect belongs in its impact estimate. A separate
optimization belongs here. Cross-link shared causes without duplicating benefit
counts. If a defect blocks a refactor, name the dependency and preserve the separation
between the behavior-changing fix and the structural change.

## 7. Deliver and review the audit

Use the user's requested format and location, otherwise the repository's audit/docs
convention. Prefer a navigable Markdown index, one execution card per opportunity,
and a separate `incidental-findings.md`. Keep all necessary instructions in the
artifacts; a fresh agent must not need the chat, hidden notes, or unstated knowledge.
For a requested single document, use clearly separated parts and stable anchors.

The index must contain:

1. Objective, preservation constraints, audited revision, support scope, baseline,
   and important limits.
2. Highest-impact-first opportunity table: rank, ID/link, mechanism, expected gain,
   confidence/readiness, effort, risk, and prerequisites. Explain the leading choices.
3. Dependency-aware implementation sequence, overlaps, alternatives, and totals only
   where estimates share a basis and do not double-count savings.
4. Coverage ledger with reviewed/partial/excluded/blocked areas and methods. Explicitly
   identify environments or consumers that could not be inspected.
5. Conditional investigations and meaningful retain/reject decisions with reasons.
6. Link to the separate prioritized incidental-findings backlog.

Before delivery, independently review the strongest and riskiest findings when another
agent is available. Give it source evidence and plans, not a required conclusion.
Otherwise perform the same critical pass yourself. Check that each plan is executable,
each deletion has a support/reachability argument, every claimed gain has a basis, and
each relevant contract has a proportionate verification method. Resolve concrete
review findings without repeatedly reopening the whole audit.

For an exhaustive audit, complete the section 3 sweep across every accessible
in-scope first-party area at a documented implementation-review depth, including
relevant cross-boundary paths. “Partially reviewed” is an interim status, not a
completion condition. Leave an area partial or blocked at delivery only because of
a specific missing prerequisite, user-imposed limit, or explicit scope exclusion;
state what remains and how to finish it. Continue until this coverage requirement is
met and all material findings are dispositioned with evidence, plans, or specific
blockers. Never claim an exhaustive review of uninspected code, or guarantee that
finite inspection found every possible issue. State completeness relative to the
audited snapshot and documented coverage.

Finish with the largest justified opportunities, what would become simpler and why,
important uncertainties, and links to the full artifacts. State that no product changes
were made. Do not substitute a short chat summary for the requested complete plans.

## Reference principles

Apply these principles using repository evidence; these sources do not endorse any
particular finding or replace verification:

- [Martin Fowler — Refactoring](https://refactoring.com/): preserve observable behavior
  through small transformations that keep the system working.
- [Google — What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html): assess system-wide complexity and avoid speculative generality.
- [Google — Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html): plan coherent changes that can be understood, checked, and rolled back.
- [Andrej Karpathy — nanoGPT](https://github.com/karpathy/nanoGPT): use plain, readable,
  adaptable code as a simplicity reference; do not copy its architecture into a
  product whose requirements differ.
