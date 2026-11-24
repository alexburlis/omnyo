# Omnyo lint policy

`pnpm lint` runs the required package checks. Before landing repository-wide
changes, also run `pnpm exec oxlint --deny-warnings --format=agent` and
`pnpm format:check` from the root.

Required lint checks enforce the comment policy, React hook ordering and
dependencies, unsafe production assertion chains, production module mocking,
accumulator copies, readable spacing, asynchronous subprocesses, workspace
ownership, plugin imports, and accessible button labels.

`pnpm lint:advisory` also reports type-style, collection-pipeline and React
Compiler recommendations. These checks remain available for review, but they do
not decide whether existing boundary adapters or compiler exclusions are valid.
For example, a parser must accept unknown input, a Proxy may need Reflect, a
partial wire payload may deliberately omit a property, and native DOM integrations
and virtualizers can require React Compiler to skip optimization. Typechecking
and the compiler's own safety checks remain unchanged.

The blanket SAFETY-comment rule conflicts with the comment ban in `AGENTS.md`.
The symbol-name rule conflicts with public protocol and SDK names such as
`DeltaItemShape`. Neither rule is enabled. Necessary casts and unknown values
still belong at validated, genuinely unknown boundaries, as `AGENTS.md` requires.

Test files and testing entry points can mock external dependencies and construct
deliberately invalid inputs. The prohibition on mocking the database still
applies. Production code retains the assertion-chain and module-mocking checks.
Explicit assertion-chain exceptions remain at the browser-import SQLite
queries, newer browser-permission APIs, native-shell globals, the validated
plugin-host entry point and the SDK's generic runtime component forwarder.
These adapters bridge runtime contracts that their upstream declarations cannot
express; internal assertion chains remain errors.
The SDK composer test harness retains one explicit dependency-rule exception:
its external-store revision invalidates a memoized view of imperative getters,
even though the revision is not part of the public view.

The server may access its own installation, data directory and artifact caches.
The filesystem exceptions in `.oxlintrc.json` cover plugin installation and
catalogs, skills staged on the server, coordinator moves, encrypted machine
environment storage, bootstrap and distribution artifacts, server themes,
primary-host identity, data-directory agent instructions and startup. These
exceptions retain the ban on importing host-workspace and host-watcher modules.
The stopped identity controller and its entry read only bound server profile and
artifact inputs through the existing maintenance and archive owners.
The finite worker bridge artifact owner reads its protected selection and verified
release archives; it keeps the approved worker offer separate from control bytes.
The content-addressed legacy worker archive route reads only staged original
worker archives from its own install cache.
Workspace filesystem access continues through daemon commands. Other server
modules retain the direct-filesystem import ban.

The CLI's initial OMNYO_CLI re-execution is the single production synchronous-child
exception. It transfers the process's terminal and exit status before command
dispatch. Other production subprocesses remain asynchronous.

The vendored anti-slop source and its original source manifest are unchanged.
Local policy is selected in `.oxlintrc.json` and `.oxlintrc-advisory.json`.
