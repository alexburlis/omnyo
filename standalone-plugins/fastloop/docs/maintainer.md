# FastLoop Omnyo adapter

Keep the adapter compatible with Node 22. FastLoop owns browser execution, planning, verification and its Node 24 runtime. Never copy those implementations into this plugin.

The adapter registers one pinned host runtime, native tools, CLI and source UI.

Native-tool context supplies the trusted thread and project. CLI/UI selectors select an owner context and are not per-thread principals. Resolve `Environment.path` and `hostId` from current SDK records, then canonicalize on that exact host. Never use cwd or a first-machine fallback.

Preserve the requirements/check scope. Inline non-secret requirement JSON is one compact line up to 16 KiB. Local files are read by the invoking CLI through `--requirements-json-stdin`, never opened on the coordinator.

Run local Oxlint autofix, then Oxfmt on changed code. Run typecheck, lint, formatting and focused routing tests. Source verification commands have a 15-second bound. No code comments except tool directives or unchanged vendored/SDK declarations.
