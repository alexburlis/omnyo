# RF-064 — Replace the second host-daemon service-file finder in server move with one `@omnyo/config` finder and parser

**Rank and disposition**

**Rank:** _unranked: the index step did not run (see [the folder README](../README.md))_

- **Verdict:** adjusted. The duplication is real. The sweep's line estimate is roughly right, but the plan direction is now fixed: the fuller host-daemon parser moves into `@omnyo/config`, and the config regex parser is deleted. The finders differ in five ways, not two. The gate below resolves them with recommended defaults, and each default is backed by what the installer actually writes.
- **Potential:** medium. One piece of duplicated knowledge disappears from two Node owners: file prefixes, suffixes, directories, the `OMNYO_DATA_DIR` match and the plist/unit environment decoding. About 105 to 120 handwritten production lines (non-blank) go away net. The CLI also gains the service manager it needs to print a correct removal command (see the separate issue below).
- **Confidence:** high on the duplication and its consumers. Medium on the exact net count, which depends on how much glue the moved code needs.
- **Readiness:** conditional. Before editing, apply the five rule decisions in Execution step 1. Each one has a recommended default. A risk only arises in edge cases that installer-written files never produce.
- **Effort:** about one day. That covers the move, fixture tests on Linux and macOS for both views, and typecheck in four packages.
- **Risk:** medium-low. The change touches machine-service detection in the CLI (`omnyo server install-machine-service`, the unlock refusal), in desktop's moved-machine keep-alive and in the `omnyo-app` launcher supervision, plus the server-move restart. A wrong match could cause one of two failures: the app could install a duplicate service, or server move could skip restarting the real service.
- **Prerequisites:** none in other RF items.
- **Related and overlapping:** none of RF-001 to RF-139 touches these files. RF-055 (machine-installer routes) touches the server routes that serve `install-machine.sh`, but not the script's own service matching. This card leaves the shell installer's matching separate.
- **Why it earns its place:** a rename of the service prefix or a new service directory currently needs matching edits in two TypeScript modules, and the two modules already disagree on four edge rules. After the change, one module owns both the file format and the discovery.

**Context and evidence**

The snapshot is commit `e9e1b74c3b906edbf2d4b4c3da8f930c62e24f9e` (origin/main, 2026-11-26). The snapshot worktree named in the task was gone when this card was written, so every citation was read with `git -C $OMNYO_CHECKOUT show e9e1b74c3…:<path>`. Line numbers refer to that commit.

On macOS and Linux, a host daemon that runs as a background service is defined by a file that `apps/server/src/assets/install-machine.sh` writes. On macOS that file is a launchd plist at `~/Library/LaunchAgents/app.omnyo.host-daemon.<slug>.plist`. On Linux it is a systemd unit, either a user unit at `~/.config/systemd/user/omnyo-host-daemon-<slug>.service` or a system unit for root at `<dataDir>/systemd/omnyo-host-daemon-<slug>.service`. The service is tied to its data directory through `OMNYO_DATA_DIR` in the file's environment. Two Node modules independently locate that file.

Observed facts (Proven by inspection):

- **Finder A, `@omnyo/config`:** `packages/config/src/machine-service.ts` (182 lines, 145 non-blank).
  - Lines 16–22 hold the prefix and suffix constants (`LAUNCHD_SERVICE_PREFIX`, `SYSTEMD_SERVICE_PREFIX` and the matching suffixes).
  - Lines 24–36 hold the regexes `LAUNCHD_DATA_DIR_PATTERN` and `SYSTEMD_DATA_DIR_PATTERN` and the `XML_ENTITIES` map.
  - Lines 51–75 are `parseLaunchdDataDir` and `parseSystemdDataDir`. The launchd parser decodes named entities only.
  - Lines 77–104 are `serviceDirectories`, which handles `darwin` and `linux`. It requires the prefix in both Linux directories, and its `prefixes` field is an array with one element.
  - Lines 106–124 are `isMissingPathError` and `canonicalPath`. `canonicalPath` rethrows any error other than ENOENT or ENOTDIR.
  - Lines 126–149 are `listServiceFiles`. Lines 151–182 are `findMachineServiceFile`, which returns only the path.
  - Lines 16–182 are 136 non-blank lines.
- **Finder B, host-daemon server move:** `apps/host-daemon/src/server-move/service-definition.ts` (539 lines).
  - Lines 13–21 repeat the same prefixes and suffixes plus `DATA_DIR_ENV_NAME`.
  - Lines 70–130 are `listMatchingFiles` and `listServiceDefinitionCandidates`. They accept `linux` or `wsl`, and in `<dataDir>/systemd` they accept **any** `.service` file (line 114).
  - Lines 136–184 are `findServiceDefinition`. It honours `OMNYO_SERVER_MOVE_SERVICE_MANAGER=none` through `forcesNoServiceManager` (line 132) and returns `{manager, path, unitName, programArguments, environment, content}`.
  - Lines 186–199 are `unescapeXml`, which decodes named and numeric entities.
  - Lines 210–249 are `parseLaunchdPlist`. It requires `Label` and `ProgramArguments`, and it reads only the `EnvironmentVariables` dict.
  - Lines 266–329 are `splitSystemdWords`. Lines 345–390 are `systemdDirective` and `parseSystemdUnit`, which require `ExecStart` and handle several assignments per `Environment=` line.
  - The block uses the host-local `canonicalPath` from `apps/host-daemon/src/server-move/fs.ts:80`, which swallows every realpath error.
  - The rest of the file is specific to server move: the formatters at lines 251–264 and 331–404, the argument rewriting at lines 406–515, and `formatServiceDefinitionContent` and `writeServiceDefinition` at lines 517–539.
- **Consumers.** These come from `git grep` for `findMachineServiceFile`, `findServiceDefinition`, `parseLaunchdPlist`, `parseSystemdUnit` and `ServiceDefinition` over the whole snapshot.
  - Finder A is called from `apps/cli/src/commands/server-machine-service.ts:189` (`findLocalMachineServiceFile`). That function is used at `server-machine-service.ts:243` and by the unlock refusal at `apps/cli/src/commands/server.ts:880-884`. Finder A is also called from `apps/desktop/src/main.ts:1808` (the `keepMovedMachineConnected` `findService` callback) and from `packages/omnyo-app/src/launcher.ts:4781` (the `superviseOmnyoAppStart` `findMachineService` callback). All three pass `process.platform`.
  - Finder B is called from `apps/host-daemon/src/server-move/service.ts:1533` (the private `findServiceDefinition`, used at `service.ts:1319` and `:2389`).
  - The type `ServiceDefinition` is imported by `service.ts:140`, `service-manager.ts:5` and `service-manager.test.ts:7`.
  - Tests: `packages/config/test/machine-service.test.ts` (212 lines) and `apps/host-daemon/src/server-move/service-definition.test.ts` (530 lines).
  - No `.md` file mentions either finder (`git grep` over `*.md`).
  - `@omnyo/config` is `"private": true` and is consumed as TypeScript source (`packages/config/package.json:147-150`). Nothing outside the monorepo uses it, so there is no external SDK contract.
  - `apps/host-daemon/package.json:26` already depends on `@omnyo/config`, and `apps/host-daemon/src/app.ts:18`, `daemon.ts:4` and `protocol-self-update.ts:13` already import `@omnyo/config/machine-service`. No new bundle edge appears.
- **What the installer writes.** The current `install-machine.sh` names system units with the prefix, at lines 193–195 and 1188–1199. Its own owner check at lines 207–208 requires the prefix in both Linux directories. Its templates always write `Label`, `ProgramArguments` and `EnvironmentVariables` (around lines 1135–1155), and `ExecStart` plus one `Environment="OMNYO_DATA_DIR=…"` line (lines 1218–1220). The escapes are `xml_escape` (named entities) and `systemd_escape` (backslash, quote, `%%`) at line 1116.
- **History.** I checked the history read-only in the retired private store. Finder B's any-`.service` rule dates from `40ec7949a7` (2026-09-16, "Add experimental server migration between machines"). Even then, that commit's installer prefixed system units in `<dataDir>/systemd` (`bb-host-daemon-`, line 181 of that revision). The looser rule therefore matched nothing extra that any installer generation wrote, which makes it incidental (Proven by inspection for the installer generations in that history). The `bb-` generation was retired by `f0f0aa9a88` (2026-11-10).

How the two finders differ, and how each rule is resolved in Execution step 1:

| # | Rule | Finder A (config) | Finder B (server move) | What installers write |
|---|---|---|---|---|
| R1 | File names in `<dataDir>/systemd` | prefix required | any `.service` | always prefixed |
| R2 | Required fields | none: a bare `OMNYO_DATA_DIR` match is enough | `Label`+`ProgramArguments` / `ExecStart` | always present |
| R3 | XML decoding | named entities only | named and numeric (decode order has a defect, see the separate issue below) | named only |
| R4 | `canonicalPath` errors | rethrows non-missing errors | swallows all errors | n/a |
| R5 | Platforms | `darwin`, `linux` | `darwin`, `linux`, `wsl` | n/a |

The systemd data-dir parse in Finder A (an anchored regex over a single quoted `Environment=` line) also accepts a narrower syntax than `splitSystemdWords`. For installer output, both parsers give the same result.

Maintenance cost today: the same directory, prefix and environment-name knowledge sits in two modules, and their edge rules have already drifted apart (R1–R4). A third copy lives in the shell installer and stays there, because it runs before any Node package is installed.

**Proposed end state and preservation argument**

`@omnyo/config/machine-service` owns everything about the machine-service file. That covers candidate directories and names, the launchd plist and systemd unit parsers, the parsers' inverse formatters, and one finder:

```ts
export type MachineServiceManager = "launchd" | "systemd-user" | "systemd-system";
export interface MachineServiceDefinition {
  manager: MachineServiceManager;
  path: string;
  unitName: string;
  programArguments: string[];
  environment: Record<string, string>;
  content: string;
}
export interface FindMachineServiceArgs {
  dataDir: string;
  homeDir: string;
  platform: NodeJS.Platform | "wsl";
}
export function findMachineServiceDefinition(args: FindMachineServiceArgs): Promise<MachineServiceDefinition | null>;
export async function findMachineServiceFile(args: FindMachineServiceArgs): Promise<string | null> {
  return (await findMachineServiceDefinition(args))?.path ?? null;
}
export function parseLaunchdPlist(content: string): ParsedMachineService | null;
export function parseSystemdUnit(content: string, unitName: string): ParsedMachineService | null;
export function formatLaunchdPlist(content: string, programArguments: readonly string[]): string;
export function formatSystemdUnit(content: string, programArguments: readonly string[]): string;
```

What disappears:

- Finder A's regex parser, its entity map, `serviceDirectories` and `listServiceFiles`.
- Finder B's duplicate constants, `listMatchingFiles` and `listServiceDefinitionCandidates`, and the parse and format code, which moves into config.

What remains in `apps/host-daemon/src/server-move/service-definition.ts`: `SERVER_MOVE_SERVICE_MANAGER_ENV`, `forcesNoServiceManager`, a two-line `findServiceDefinition` (`forcesNoServiceManager(args.env) ? null : findMachineServiceDefinition(args)`), the argument rewriting, `formatServiceDefinitionContent` and `writeServiceDefinition`. These keep using `writeFileAtomically` from the host-local `fs.ts`. The host-local `canonicalPath` in `fs.ts` stays for its other callers.

The formatters move with the parsers because they share `LAUNCHD_PROGRAM_ARGUMENTS_PATTERN` and `systemdDirective`. Splitting a file format's reader from its writer across packages would create a new coupling.

Preservation argument:

- For every file that the current installer writes, both finders already return the same path. Both iterate the user directory before the system directory, both sort names, both compare canonical data dirs, and both decode the same escapes.
- The three Finder A callers keep `findMachineServiceFile` and its `Promise<string | null>` signature, so their code does not change.
- Server move keeps its result shape, its `OMNYO_SERVER_MOVE_SERVICE_MANAGER=none` escape and its `wsl` support.

The intentional rule changes (only the ones the gate adopts) affect only hand-made or foreign files:

- R1 narrows server move to prefixed system units.
- R2 narrows the three config callers to files that can actually start a daemon.
- R3 widens the config callers to numeric entities and fixes the decode order.
- R4 is the one choice that can change behavior on a real machine (an unreadable foreign data dir). Its default keeps the config callers' current behavior.

Non-goals:

- Changing `install-machine.sh` or `install-machine-windows.mjs`.
- Changing the CLI removal hint. That is a separate issue, and the hint becomes easy to fix once `manager` is available.
- Merging host-daemon's `fs.ts` helpers into config.
- Windows (`machine-service.json`) discovery.

This is the simplest sufficient option. Finder B's parser is a superset of Finder A's for real files and is already needed for the rewrites. Making Finder A a view over it removes one implementation without adding a layer.

**Expected gain and cost**

All counts are non-blank lines at the snapshot (`git show <commit>:<path> | sed -n 'A,Bp' | grep -cv '^\s*$'`). This is a measurement of the current code. The after-state figures are projections.

- Deleted handwritten production code: Finder A lines 16–182 total 136. Of those, `isMissingPathError` and `canonicalPath` (17) survive and serve the moved code, so about 119 lines are deleted. Finder B's constants and its `DATA_DIR_ENV_NAME` (about 5) are deleted too.
- Moved, not counted as a reduction: Finder B's listing and finder (53 + 40), its parsers (14 + 31 + 52 + 35) and its formatters (about 45) move into config.
- Added glue (projection): the `findMachineServiceFile` view (3 lines), the server-move `findServiceDefinition` wrapper (about 5), `wsl` in the platform type (1), and the import rewiring in `service.ts`, `service-manager.ts` and `service-manager.test.ts`.
- **Net (projection): about 105 to 120 fewer production lines.** One finder remains instead of two, and the edge rules are written down once.
- Tests: the parser and formatter tests move from `service-definition.test.ts` to `packages/config/test/machine-service.test.ts`. The config fixtures in `writeLaunchAgent` (`machine-service.test.ts:54-78`) need `Label` and `ProgramArguments` if R2 is adopted. Test lines move rather than shrink.
- Performance: neutral by inspection. Each candidate file is still read once. The full parser does somewhat more string work per file than one regex, on a handful of small files. The callers are startup and supervision paths, not hot paths. No benchmark exists, and none is needed at this scale.
- Maintenance effect: one place to change a prefix, a directory or an escape rule, and one test suite that encodes them.

**Execution steps**

1. **Gate: reconfirm and decide the rules (required before any edit).**
   - Re-read the two source files and the installer lines cited above at the current HEAD. If `install-machine.sh` now writes system units without the `omnyo-host-daemon-` prefix, or writes plists without `ProgramArguments`, stop and re-plan.
   - Decide and record each rule in the commit message:
     - **R1 (recommended): require the prefix in `<dataDir>/systemd`.** This matches every installer generation and the installer's own owner check.
     - **R2 (recommended): a match requires a parseable definition** (`Label`+`ProgramArguments`, or `ExecStart`). A file without these cannot run a daemon, and desktop or the launcher would then reinstall, which the installer refuses safely while a file with the same name exists (`install-machine.sh` near 1130 and 1209, "already has an owner").
     - **R3 (recommended): decode named and numeric entities in one pass**, so that `&#38;lt;` yields `&lt;`.
     - **R4 (recommended): keep config's `canonicalPath`**, which rethrows non-missing errors. This is the current behavior for three callers and fails visibly. It does change server move: an EACCES on another unit's data dir would abort the lookup instead of being ignored. If the owner prefers that server move keep ignoring such errors, catch the error per candidate inside the shared loop and skip that candidate, logging nothing silently. Do not keep two `canonicalPath` semantics.
     - **R5: accept `"wsl"`.**
   - Any rule the owner rejects becomes an explicit option on `FindMachineServiceArgs`. Do not fork the code.
2. **Characterization first, against the unchanged code.**
   - Add the following cases to `packages/config/test/machine-service.test.ts`:
     - a launch agent whose data dir contains `&`, `<` and `'`;
     - a user unit with two assignments on one `Environment=` line, which Finder A misses today (record the current result);
     - a non-prefixed unit in `<dataDir>/systemd`, which Finder A ignores and Finder B accepts;
     - a symlinked data dir (this case exists at lines 137–152).
   - Run both packages' tests and record the results. They are the baseline. The rows where the finders differ must change only as the gate decided.
3. **Checkpoint 1: move without changing semantics (mechanical).**
   - In `packages/config/src/machine-service.ts`, add `MachineServiceManager`, `MachineServiceDefinition`, `FindMachineServiceArgs`, `listMachineServiceCandidates` (from `listServiceDefinitionCandidates`), `findMachineServiceDefinition` (from `findServiceDefinition`, minus the `env` check), `unescapeXml`, `escapeXml`, `parseLaunchdPlist`, `formatLaunchdPlist`, `splitSystemdWords`, `formatSystemdWord`, `systemdDirective`, `parseSystemdUnit` and `formatSystemdUnit`.
   - Reuse config's existing `isMissingPathError` and `canonicalPath`.
   - Keep Finder A's old code in place during this checkpoint only.
   - Point `apps/host-daemon/src/server-move/service-definition.ts` at the config exports. `findServiceDefinition` becomes the `forcesNoServiceManager` wrapper. Import the formatters for `formatServiceDefinitionContent`. Delete the moved bodies and constants.
   - Change `service.ts:140`, `service-manager.ts:5` and `service-manager.test.ts:7` to import `MachineServiceDefinition` from `@omnyo/config/machine-service`. Rename the uses in place, or import as `ServiceDefinition` only within those files. Do not keep a re-exporting alias in `service-definition.ts`.
   - Move the `parseLaunchdPlist`, `parseSystemdUnit` and `formatSystemdUnit` tests from `service-definition.test.ts` to the config test file unchanged.
   - Verify: host-daemon and config tests pass with identical assertions.
4. **Checkpoint 2: one finder (semantic).**
   - Replace `findMachineServiceFile`'s body with the `findMachineServiceDefinition(args)?.path` view.
   - Delete Finder A's `LAUNCHD_DATA_DIR_PATTERN`, `SYSTEMD_DATA_DIR_PATTERN`, `XML_ENTITIES`, `ServiceDirectory`, `parseLaunchdDataDir`, `parseSystemdDataDir`, `serviceDirectories` and `listServiceFiles`. Rename `FindMachineServiceFileArgs` to `FindMachineServiceArgs` (it has no importers outside the file).
   - Apply the gate's decisions: R1 (prefix filter in the system directory), R3 (single-pass decode) and R4 (one `canonicalPath`).
   - Update the config fixtures in `writeLaunchAgent` to the installer's real shape with `Label` and `ProgramArguments`, if R2 was adopted. This is a deliberate contract change, so record it in the commit message. Do not weaken any assertion.
   - Verify: the step-2 characterization rows change only where the gate decided.
5. **Clean up.** Confirm with `git grep -n -e LAUNCHD_PLIST_PREFIX -e SYSTEMD_USER_UNIT_PREFIX -e LAUNCHD_SERVICE_PREFIX -e listServiceDefinitionCandidates -e parseLaunchdDataDir` that the old names and constants are gone and that exactly one prefix definition remains. No export map, docs or dependency changes are needed.
6. **Final check.** Run the verification below. Inspect the full diff for leftovers or unrelated edits. Recount the non-blank lines of both files against the step-1 baseline and report the actual net change.

**Verification and acceptance criteria**

The working directory is the repository root. Every script below exists in the package's `package.json` at the snapshot (read directly). The snapshot has no `node_modules`, so none of these commands were run for this card.

- `pnpm --filter @omnyo/config test` runs `vitest run --config vitest.config.ts`. It covers the finder on darwin, linux and win32, the symlinked data dir, quoting and `%`, the moved parser tests and the new rows for R1 to R3.
- `pnpm --filter @omnyo/host-daemon test`. The `service-definition.test.ts` cases must pass: user and system units, decoding of `&amp;` in a launch agent, `OMNYO_SERVER_MOVE_SERVICE_MANAGER=none`, rewrites that keep `%` and `$`, and preserved file mode. The `service-manager.test.ts` and server-move `service*.test.ts` suites must also pass.
- `pnpm --filter @omnyo/cli test`, which runs `vitest run`. It covers `__tests__/command-output/server-machine-service.test.ts` and `server-machine-service-refusal.test.ts`.
- `pnpm --filter @omnyo/desktop test`, which needs `test:prepare` (`install-electron`) first and covers `test/moved-machine-service.test.ts`. Also run `pnpm --filter omnyo-app test`, which covers `test/host-daemon-supervision.test.ts`. The package name `omnyo-app` was confirmed in `packages/omnyo-app/package.json`.
- Run `pnpm --filter <pkg> typecheck` for `@omnyo/config`, `@omnyo/host-daemon`, `@omnyo/cli`, `@omnyo/desktop` and `omnyo-app`. Each runs `tsc --noEmit`.
- Run `pnpm --filter @omnyo/config lint` (`oxlint src`), then `pnpm exec oxfmt <changed files>` and `pnpm format:check` (root `oxfmt . --check`).
- Manual acceptance on a real host is optional and needs the owner's request. On a Linux host and a macOS host enrolled by `install-machine.sh`, two checks apply. First, `omnyo server install-machine-service` on a moved data dir reports the same service file as before. Second, a server-move restart on that host still finds and restarts the same unit. Each check needs a host that Alex supplies.
- Structural: exactly one definition of each prefix and suffix exists in TypeScript, and exactly one candidate-listing function and one set of plist and unit parsers exist. The config callers' code is unchanged, and `findMachineServiceFile` is a one-expression view.

**Rollback and stop conditions**

- Rollback boundary: the change consists of the two checkpoint commits, which touch `packages/config` and `apps/host-daemon/src/server-move` only. Reverting them restores both finders. No persisted data, file format or wire contract changes. Service files on disk are read, never migrated.
- Stop, and keep the R-rule as an option, if any of these turns up:
  - a supported install path (a desktop-bundled installer, a docs-recommended manual unit, or an older installer still served by `apps/server`) that writes non-prefixed system units or plists without `ProgramArguments`;
  - a test showing that a real installer-written file is matched by one finder and not the other;
  - a server-move test that fails under R4.
- Stop if `@omnyo/config` gains a public or packed consumer outside the monorepo before execution. In that case its exports would become a compatibility surface.
- Smaller safe alternative if the gate stalls: move only the constants and `listMachineServiceCandidates` into config, and let each finder keep its parser. That alternative saves about 40 lines and the prefix and directory duplication, and it leaves the parser divergence documented.
