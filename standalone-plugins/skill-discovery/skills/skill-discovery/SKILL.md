---
name: skill-discovery
description: Organize installed Omnyo and provider skills and saved prompts by collection, workspace, provider and scope. Use the Skills navigation panel or the bounded skill-discovery CLI to locate relevant instructions.
---

# Skills

Open **Skills** in the Omnyo navigation rail to browse categories and short descriptions. Search names or task words, choose a workspace/provider/scope, and select a skill to read the exact source variant. Sources with the same discovery description are grouped; their instruction bodies remain separate.

Use `omnyo skill-discovery list --category "Development" --limit 40` to list one category; categories come from the installed skills' namespaces, shared name prefixes and broad topics. Use `omnyo skill-discovery list --query "shader" --provider codex --json` for bounded machine-readable results.

The command uses the invoking project's actual skill inventory and matching thread environment. Override with `--project <id>` and `--environment <id>`. It returns up to 30 rows by default; `--limit` accepts 1-200. Core `omnyo skill` remains the owner of installation and editing.

Use `omnyo skill-discovery inspect --source <source-id> --json` with an opaque source ID from `list --json` to inspect that exact variant. It reports content identity, Claude frontmatter controls and the sibling Codex policy through the selected host. Declared values and defaults are distinct. Effective enablement, canonical identity and actual model inclusion remain unknown; a missing optional policy is not a read failure.

Browsing, inspecting or selecting a skill does not run it. Apply the receiving project's instructions and the user's authority before using the skill.

## Find curated skills

Open **Skills → Marketplace → Curated skills** to search curated skills and review their files before installing into the selected workspace. In the chat composer, **+ → Find skills** shows installed matches first. Selecting a **Use once** result adds its instructions to the unsent draft for one message. Choose **Install…** for a permanent copy.

`omnyo skill-discovery catalog-search --query "write documentation"` returns matching IDs and a catalog generation. Use `catalog-review --id ID --generation GENERATION --project PROJECT_ID` to inspect the exact files and workspace. After review, `catalog-confirm --review REVIEW_ID --digest SHA256 --yes` installs that copy. Pass `--environment ENVIRONMENT_ID` to the review command for a specific workspace.

`catalog-prepare --id ID --generation GENERATION` returns the verified one-time reference used by the composer. Preparing a reference leaves the workspace unchanged. The composer sends its instructions only when the user submits the message.

## Organize the selected workspace

Open **Skills** to create collections and subcollections, link individual sources or project files, and write saved prompts. Rename or move a link to organize it while preserving the source’s invocation ID. Use **Use in chat** to prepare a draft for the native composer. A separate user submission starts the chat.

From the CLI, read `omnyo skill-discovery library` and pass its revision to `omnyo skill-discovery library-apply --revision N --operation JSON`. If the workspace changed, reload it before retrying. Use `omnyo skill` for individual source management.

## Import, export and review

Use **Export Markdown** on an installed skill or **Export pack** on a collection. Drop one `.md` or `.omnyoskillpack` file onto Skills, or use **Import → Choose file**. Review the destination, publisher, version, files and prompts. Confirm only the intended package and project. References to private project files stay local. Install writes the reviewed files and makes the skill available to configured agents. It executes no scripts and sends no prompt.

`omnyo skill-discovery pack-review --file /absolute/path/example.omnyoskillpack` shows the review ID and SHA-256. The same command accepts a `.md` file. For an Omnyo pack listing, pass `--slug` and `--digest` instead. For an individual Marketplace listing, add `--marketplace`. Use `pack-confirm --review REVIEW_ID --digest SHA256 --yes` only after review. Repeating the same install returns the same receipt. An edited or different existing version is preserved.

## Prompt history and favorites

Choose **Skills → Prompt history**, or use **+ → Prompts…** and **Ctrl+R** in a composer. Search your previous prompts, starred favorites and saved or imported workspace prompts. The composer picker keeps the Thread, Project and All scopes, keyboard selection, full preview and text insertion. Insertion never sends a message. Into an empty composer it restores history mentions and attachments; into an existing draft it inserts text and mentions at the cursor. Stars retain text and mentions, without attachments.

Saved prompts and imported packs keep their project/environment libraries. Starred favorites remain global. The history comes from Omnyo's user-prompt API; cached history remains available until plugin reload even if core later removes an entry. The initial search pages through all available history, then fetches newer entries.

Use `omnyo skill-discovery prompt-search [query...] [--project ID | --thread ID] [--json]`, `prompt-list [--json]`, `prompt-star <text...>` or `prompt-unstar <id>`. Existing `omnyo prompts search|list|star|unstar` and Prompt Library RPCs forward to Skills after the legacy stars have been imported successfully. Without a compatible Skills plugin, Prompt Library keeps its standalone behavior.

Migration preserves legacy records, IDs, mentions and timestamps. Import receipts make retries idempotent, including after unstar. The `promptLibraryStatus` RPC returns `{ "version": 1 }` only after migration; a failed migration remains retryable and does not announce readiness.

## Credits

The prompt picker, history search and ranking build on the [bb Prompt Library](https://github.com/get-bb/bb/tree/main/plugins/prompt-library) by Michael Yong and the bb contributors, extended by Omnyo. Its MIT license is retained in [LICENSE.prompt-library.txt](LICENSE.prompt-library.txt).
