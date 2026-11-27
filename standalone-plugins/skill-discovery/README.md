# Skills

Open **Skills** in the Omnyo navigation rail. **Installed** shows the selected workspace's skills, collections and saved prompts. Inspect the exact source and use **Export Markdown** to download its `SKILL.md`. Use **Export pack** on a collection to include its skill packages and saved prompts in a portable file.

Drag a Markdown or `.omnyoskillpack` file onto Skills, or use **Import → Choose file**. Review the selected workspace and contents before installing. A valid `SKILL.md` keeps its bytes. Plain Markdown uses its filename for the skill name, or its first heading if the file is named `SKILL.md`.

## Marketplace

Choose **Marketplace** within Skills to find items from Omnyo's public catalog. The panel opens on skills and also offers workflow and connector filters. **Review package** uses the full curated package when the catalog source, revision and digest match. **Review Markdown** imports the listed `SKILL.md`; check the source for any supporting files or setup. The marketplace's native links open the same review using the listing's pinned digest. Workflow cards open Automations review. Configurable connectors link to their plugin settings.

The core `omnyo explore marketplace` command lists the catalog. The plugin RPC `marketplaceGet` returns the validated catalog and exact curated matches. The `packReview` RPC accepts local packs, Markdown, published packs and pinned marketplace listings.

## Development

Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:marketplace`, the affected existing tests and `pnpm build`. Use an isolated profile for candidate UI checks; building does not activate the plugin.

## CLI

`omnyo skill-discovery list --category "Development" --limit 40`

`omnyo skill-discovery list --query "shader" --provider codex --json`

Results default to the invoking project and matching thread environment. Use `--project <id>` and `--environment <id>` to select another workspace. Results are bounded to 30 rows by default and 200 at most.

Category labels are deterministic discovery aids derived from the installed skills. A provider plugin namespace with three or more skills, or a name prefix shared by three or more skills, becomes a top-level group; two or more members sharing the next name part form a subgroup. Omnyo plugin skills group by plugin. Remaining skills fall under a broad topic matched from their name, or Other. Source variants and complete descriptions remain inspectable.

The [live verification guide](tests/live-browser.md) checks browse, search, source reads and responsive behavior against the installed plugin.

Regular source previews read the discovered SKILL.md through the public file SDK on the selected workspace host, including shared-skill aliases. Plugin-owned instructions use the public skills SDK. A failed selected source stays visible as an error; another variant is never substituted.

## Inspect an exact source

Run `omnyo skill-discovery list --query "aws-storage" --provider codex --json`, then copy a source's opaque `id` into:

```sh
omnyo skill-discovery inspect --source <source-id> --json
```

The command uses the same project and matching thread environment as `list`. It reads only that exact source's `SKILL.md` and optional sibling `agents/openai.yaml` through the public SDK on the selected workspace host. Plugin-owned and Omnyo user sources use the skills API, which resolves their exact owner. It reports the returned source identity, content SHA-256, and Claude and Codex invocation declarations.

A declared value is distinct from a documented default. The package API does not distinguish an unlisted optional policy from an unreadable one, so that case remains unavailable rather than implying absence. A missing optional policy is distinct from an unreadable file, malformed YAML, non-UTF-8 content, or a truncated package listing. Read failures remain visible and another variant is never substituted.

These declarations do not establish native configuration enablement, canonical realpath identity, the native selected plugin installation, or actual model inclusion. Those states remain `unknown`. Inspecting never invokes the workflow, starts a model turn, or changes the source. Existing manual specialists stay searchable even when their declarations exclude automatic model invocation.

## Collections and packs

Open **Skills** to manage collections and saved prompts for the selected project and environment. Collection links retain the exact source. Inferred categories and the existing list/inspect commands remain available.

- `omnyo skill-discovery library` returns the current workspace's revision, collections, links, and prompts.
- `omnyo skill-discovery library-apply --revision 0 --operation '{"kind":"collection.create","parentId":null,"title":"Research","description":""}'` applies a revision-checked operation. Read the current revision before changing anything.
- `omnyo skill-discovery pack-export --collection ID --publisher local --slug research --version 1.0.0 --license MIT` writes the selected collection's exact skill sources and saved prompts as JSON. Redirect stdout to save a `.omnyoskillpack` file.
- `omnyo skill-discovery pack-review --file /absolute/path/research.omnyoskillpack` returns the review and checks the destination without writing. Pass a `.md` path to review Markdown. For an Omnyo Explore pack, use `--slug` and `--digest`. For a marketplace skill listing, add `--marketplace`.
- `omnyo skill-discovery pack-confirm --review REVIEW_ID --digest SHA256 --yes` applies that review to the same destination. Identical retries return the same receipt.

Use `omnyo skill show <skill-id> > skill.md` to export one exact installed source. Private project reference links and history stay in the workspace. Unsupported sources, non-portable files and conflicting copies need a visible choice. Browse and draft actions never submit a prompt.

## Prompt history and favorites

Choose **Skills → Prompt history**, or use **+ → Prompts…** and **Ctrl+R** in a composer. Search your previous prompts, starred favorites and saved or imported workspace prompts. The composer picker keeps the Thread, Project and All scopes, keyboard selection, full preview and text insertion. Insertion never sends a message. Into an empty composer it restores history mentions and attachments; into an existing draft it inserts text and mentions at the cursor. Stars retain text and mentions, without attachments.

Saved prompts and imported packs keep their project/environment libraries. Starred favorites remain global. The history comes from Omnyo's user-prompt API; cached history remains available until plugin reload even if core later removes an entry. The initial search pages through all available history, then fetches newer entries.

Use `omnyo skill-discovery prompt-search [query...] [--project ID | --thread ID] [--json]`, `prompt-list [--json]`, `prompt-star <text...>` or `prompt-unstar <id>`. Existing `omnyo prompts search|list|star|unstar` and Prompt Library RPCs forward to Skills after the legacy stars have been imported successfully. Without a compatible Skills plugin, Prompt Library keeps its standalone behavior.

Migration preserves legacy records, IDs, mentions and timestamps. Import receipts make retries idempotent, including after unstar. The `promptLibraryStatus` RPC returns `{ "version": 1 }` only after migration; a failed migration remains retryable and does not announce readiness.

## Credits

The prompt picker, history search and ranking build on the [bb Prompt Library](https://github.com/get-bb/bb/tree/main/plugins/prompt-library) by Michael Yong and the bb contributors, extended by Omnyo. Its MIT license is retained in [LICENSE.prompt-library.txt](LICENSE.prompt-library.txt).
