# Curated source maintenance

The catalog contains 22 reviewed entries: 16 from GitHub Awesome Copilot, four from Vercel Agent Skills, one from Superpowers, and one from Supabase. It is a small selection, not a mirror or a search of the publishers' current catalogs.

## Refresh the approved snapshot

Run these commands from the Skill Library directory with Node 22:

```sh
pnpm curated:refresh --check
pnpm curated:refresh --write
pnpm test:curated
pnpm test:pack
```

`--check` downloads each exact approved source, checks SHA-256, validates the resulting skill package, and reports additions, updates, removals, and exclusions. It does not install skills or change the snapshot. `--write` performs the same checks before replacing and formatting `curated-snapshot.ts`.

To change the selection, edit `curated-allowlist.json` after reviewing the publisher's complete skill directory, instructions, invocation declarations, and license at the new commit. Record every included file and its SHA-256. Retain the publisher's notices and update `curated-notice-sources.json` when the license source changes. List reviewed exclusions in `curated-exclusions.json`.

`curated-vercel-manifest.json` preserves the publisher's nine-entry manifest observed on 23 November 2026 at `https://vercel.com/.well-known/agent-skills/index.json`. The refresh command checks selected Vercel assets against those published URLs and digests. Updating Vercel entries also requires the corresponding publisher manifest.

## Pinned sources and notices

| Publisher              | Revision                                   | Source and license evidence                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Awesome Copilot | `f10fdb8b2660ce85c98f220b2f1ca24653768a5c` | Each selected complete `skills/<name>/` directory; the root MIT license appears in `LICENSE.curated-github.txt`.                                                                                                    |
| Vercel Agent Skills    | `5a37a6329fbad3666c3207392a6a7c0110e92efb` | Four release assets from the publisher manifest; the pinned README declares MIT. That revision has no standalone LICENSE or copyright notice. `LICENSE.curated-vercel.txt` preserves the declaration and MIT terms. |
| Superpowers            | `22f0b463e7a5e579904dd6211a520321035526f7` | The complete `skills/brainstorming/` directory; the root MIT license appears in `LICENSE.curated-obra.txt`.                                                                                                         |
| Supabase Agent Skills  | `c9be0e931b7930f7d02126d04774d904c381e7d7` | The complete `skills/supabase-postgres-best-practices/` directory; the root MIT license appears in `LICENSE.curated-supabase.txt`.                                                                                  |

The loader returns every selected file and a `LICENSE.curated.txt` notice. Vercel archives retain their supporting rule and reference files, including underscore-prefixed files. It neither extracts onto disk nor runs bundled scripts. Only the confirmed installer writes files.

## One-time use

Eight entries have approved standalone instructions: `documentation-writer`, `javascript-typescript-jest`, `refactor-plan`, `review-and-refactor`, `sql-code-review`, `sql-optimization`, `postgresql-code-review`, and `shuffle-json-data`. Each approval records the SHA-256 of `SKILL.md`. The loader checks that digest, the skill name, and invocation declarations before returning the files.

The other entries require installation. PDF, Word, and Excel converters depend on bundled scripts and setup instructions. Web design and GitHub Actions reviews depend on bundled references. The two Playwright skills explicitly require Playwright MCP. Vercel composition and React skills depend on bundled rules, and writing-guidelines fetches a separate handbook when invoked. These requirements are preserved in the source instructions; installing a skill does not provision its external tools.

Superpowers brainstorming includes its visual companion, scripts, and builder-review prompt. Its handoff requires the separately installed `superpowers:writing-plans` skill; installing this entry does not install that separate skill. Supabase Postgres Best Practices includes all 34 reference files, its changelog, and its entry point. Both entries are installation-only. The reviewed trees contain no additional license files or conflicting file-level license notices.

## Download limits

Only HTTPS downloads from GitHub and raw.githubusercontent.com are admitted. Redirects can additionally reach release-assets.githubusercontent.com. Each request allows four redirects and 15 seconds. A complete skill has a 45-second deadline. Downloads stop above 1 MiB; decompression stops above 2 MiB; the existing skill-pack validator enforces its 768 KiB package limit, portable paths, matching frontmatter, and file-count limit. Archive links and special entries are rejected.

The catalog loads from the committed snapshot without network access. Selecting a result fetches only that result's pinned artifact. There is no automatic refresh or fallback to a branch, another source, or an unverified artifact.
