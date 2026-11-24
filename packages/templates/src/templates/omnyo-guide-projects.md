---
kind: instruction
title: Omnyo Guide — Projects
summary: Command reference for project CRUD, attachments, and sources.
intent: Provide complete project command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Project commands

A project maps to a code repository. All threads belong to a project.

  omnyo project list                         List ordinary projects
    --include-personal                    Also include the personal project
  omnyo project discover                     Find recently used git repos
    --machine <id-or-name>                Machine to scan (default: local)
    --host <id-or-name>                   Alias for --machine
  omnyo project history <id>                 List prompt history
  omnyo project reorder <id>                 Reorder in the sidebar
    --after <id>                          Previous project, or omit for start
    --before <id>                         Next project, or omit for end
  omnyo project create --name "..." [options]
    --root <path>                         Project source path
    --machine <id-or-name>                Bind the path to a connected machine
    --host <id-or-name>                   Alias for --machine

  An explicit machine/host selector accepts an exact ID or unambiguous name and
  binds --root to that machine. Omitting the selector preserves the existing
  local CLI machine fallback (normally the server machine).

  omnyo project show <id>                    Show project details
    Accepts proj_personal to inspect Personal.
  omnyo project update <id>                  Update a project
    --name <name>                         New name
    --icon <path>                         Custom PNG icon, up to 512 × 512 and 48 KiB
    --reset-icon                          Restore automatic icon discovery

  Icons sync between clients and work when project machines are offline.
  SDK: projects.update({ projectId, customIcon: pngDataUrl }); null resets.

  omnyo project delete <id>                  Delete project and all threads
    --yes                                 Skip confirmation

Global prompt history:

  omnyo prompt-history list [--cursor <cursor>] [--limit <number>]

  Lists accepted prompts across projects and threads newest first. Pass the
  returned cursor to continue from the next page.

  Prompt history omits prompts larger than 256 KiB.

Discovery:

  omnyo project branches <id> --host <id>   List branches for a machine source
  omnyo project paths <id>                   Search workspace paths
  omnyo project files <id>                   List workspace files
  omnyo project content <id> <path>          Read file content (binary is base64)
  omnyo project commands <id> --provider <id>
                                          List commands and skills
    --snapshot                           Read prepared metadata without waiting for discovery
    --machine <id-or-name>                Target project source machine
    --host <id-or-name>                   Alias for --machine
    --environment <id>                    Target environment workspace

  The machine/host and environment selectors are mutually exclusive. An
  environment selects its owning machine and workspace; otherwise an explicit
  machine selects that machine's project source. Omitting both intentionally
  falls back to the server machine's project source.

  `--snapshot --json` reports `preparing`, `ready`, or `failed` with the known
  commands and any discovery failure. The coordinator refreshes tracked catalogs
  independently. Without `--snapshot`, the command waits for a complete refresh.

  Personal file access (`paths`, `files`, `content`) requires an explicit
  --environment <id> belonging to Personal. Personal has no default project
  source; the selected environment must be ready.

Attachments:

  omnyo project attachment upload <id>       Upload bytes from the CLI machine
    --client-file <path>                  Path read on this CLI machine
    --filename <name>                     Attachment filename override
    --mime-type <type>                    MIME override (otherwise inferred)
  omnyo project attachment download <id> <attachment-path>
    --client-file <path>                  Destination on this CLI machine
    --thumbnail-width 160|320|640         Lossless image preview; original when unsupported
  omnyo project attachment retain <id> <thread-id> <paths...>
                                         Keep up to 24 existing attachments
  omnyo project attachment diagnostic <report.json> [--json]
                                         Log a content-free upload failure report

  Uploads use multipart bytes and return a server-managed attachment DTO. Pass
  its relative `path` to thread --file/--image input. Thread --file and --image
  upload absolute paths and file: URLs from the CLI machine automatically;
  relative values remain existing server attachment paths.
  Uploads are limited to 35MB per attachment.
  image/heic and image/heif uploads are rejected because no renderer or
  provider can decode them; convert them to JPEG or PNG first.
  Empty (0-byte) uploads are rejected with code `attachment_empty`, and the
  coordinator logs `Rejected empty attachment upload`. When the app detects an
  empty pasted or uploaded file, it sends a content-free report to the
  coordinator log as `Attachment upload diagnostic`. The report includes sizes,
  clipboard types, timing, native-path facts and the web bundle, never names,
  paths or bytes. `omnyo project attachment diagnostic` submits the same strict
  format through `sdk.system.experimental_recordAttachmentDiagnostic`.

  Retain uses the attachment's source project ID and an owning thread ID.
  The thread may belong to another project; bytes stay in the source project.
  Retention is idempotent and lasts until the last owning thread is deleted.
  Forks in the owning thread's project preserve its attachment references.
  Missing, pending or expired attachments are rejected together without
  retaining any paths from that request.

Sources:

  Projects can have multiple machine-local path sources.

  omnyo project source add <projectId>       Add a source
    --path <path>                         Local path
    --clone                               Clone the project's Git remote
    --remote-url <url>                    Git remote override for --clone
    --target-path <path>                  Destination override for --clone
    --machine <id-or-name>                Target machine (--host is an alias)
    --default                             Set as default source

  Explicit project source selectors must name a connected machine. Omitting
  the selector preserves the same local CLI machine fallback as project create.

  omnyo project source update <projectId> <sourceId>
    --path <path>
    --default

  omnyo project source delete <projectId> <sourceId>

Project source deletion remains available while a project is pending deletion so providers can finish cleanup. A live project must retain at least one source; a deleting project may remove its last source.

Workspace file and path searches honor Git ignore rules, including local and
global exclusions. Tracked files and non-ignored untracked files remain
searchable, including hidden files. Non-Git workspaces use filesystem listings.
Use `omnyo file list|paths` for filesystem listings that include ignored files,
subject to their explicit exclusion options.
