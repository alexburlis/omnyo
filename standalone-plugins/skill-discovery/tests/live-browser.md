# Live verification

## Marketplace candidate

Build the candidate with `pnpm build`. The SDK fixture reads the built `dist/app.js` and uses installed development tools without adding dependencies:

```sh
node tests/marketplace-ui.mjs /absolute/path/to/@testing-library/react/dist/index.js /absolute/path/to/jsdom/lib/api.js
```

The fixture covers all three item kinds, native route links, exact package review, query filtering, pagination, retry, disabled connector settings, Markdown import by picker and drop, and exact Markdown export. `pnpm test:marketplace` checks the wire schema, source matching, search and bounded catalog fetch. These checks prove candidate behavior through the SDK harness; they do not prove the plugin is installed or rendered by a physical client.

For authorized candidate browser verification, open `/plugins/skill-discovery/browse/marketplace` on an isolated profile. Search and filter all three types, open a matching package review and return without confirming, inspect workflow and connector link destinations without activating them, and check 390 px and desktop widths. A missing, disabled or unconfigurable connector must not offer Configure. A failed catalog must show Retry rather than old results.

## Markdown round trip

Use a disposable project with an existing checkout. Open Skills, drag a Markdown file onto it, and verify the destination and SKILL.md in the review. Cancel and check that the skill inventory is unchanged. Import the same file with **Import → Choose file**, confirm, and find it under Installed. Use **Export Markdown** and compare its contents to the reviewed file. Import a valid `SKILL.md` with frontmatter and confirm that export preserves the original bytes.

## Installed skills

Run against the installed plugin in real Chrome at /plugins/skill-discovery/browse.

1. Wait for the live inventory to load. Record descriptor and source variant counts.
2. Select a category that has nested groups, then one nested group. Expect exactly the installed skills in that group, labelled without the category prefix.
3. Search an installed skill's title and select provider codex. Expect one result with that descriptor.
4. Open it. Expect its current instructions and command ID.
5. Change source variant to Claude when unfiltered. Confirm its linked source path and current instruction body load. Regular skill previews use the discovered file on the selected workspace host; plugin-owned previews use the skills API. Both must report failures visibly; do not substitute another variant.
6. Select a provider/scope combination. Every visible variant must match both filters; grouping must not invent a cross-provider match.
7. Search a nonexistent term. Expect an explicit empty state.
8. Clear filters. Collapse and reopen the category with the keyboard and verify nested groups.
9. Select another project and an environment. Refresh the inventory, reload the page, then change between 1440x1000 and 390x844. The selected project and environment must remain selected, and the current inventory and exact source preview must load from that workspace. A fresh browser without a saved selection still starts from the current Omnyo project. A removed project must not retain an invalid selection.
10. Check that the library and refresh glyphs render their registered artwork rather than the host's generic bolt. Check at 1440x1000 and 390x844. Inspect current screenshots, no page overflow, readable hierarchy and reachable details.
11. Record unexpected UI/console failures and the actual source/build revision. Restore the temporary viewport override.

## Library and pack acceptance

Use a disposable project environment with two sources for the same skill or the isolated pack fixture. Keep the native composer unsent through these checks.

1. Create a collection and nested branch. Add one exact skill source to the branch as Start here. Collapse the branch, expand it, then rename the link. Reload and verify the display title and source path. Reset the name and verify the skill ID stays unchanged.
2. Create a saved prompt, link it to the collection, then move its link to a different branch. Create a project file reference and open it. Make an edit to a disposable skill from another client while the editor is open and check that the stale save preserves the draft.
3. Search for the exact skill ID and a path. Check that the exact ID ranks first and that the result identifies its collection. Open the variant picker and read the alternate source. Use in chat must open a source-choice notice for an ambiguous provider resolution. Add the file reference to the tray and open it in the native composer. Verify the project, provider, environment and visible draft without submitting.
4. Export a curated collection. Review the file and prompt manifest, then download the pack. In a clean disposable workspace, review the same pack. Confirm its digest and destination, then install. Verify the resulting collection tree and core skill inventory. Replay review and confirm the existing receipt. Cancel before confirmation in a second disposable workspace and verify no skill files appeared.
5. At 708 px verify three contained panes. At 390 px check the collection, items, and details progression. Back must return focus to the row that opened the next pane. Check the opening width at 620 px of content. Verify the / search shortcut and arrow key navigation.

The primary proof is live SDK-backed browse, authoring and pack behavior. These checks leave the draft unsent and do not certify native provider execution.

## Collections, drafts and packs

Use an isolated workspace and an original fixture pack. Collect both UI and CLI evidence without invoking a provider.

1. Open Skills. Check the selected project and environment, a real inferred category, and an exact-ID search. Verify the matching row and exact source in its inspector.
2. Add a collection and child. Link an exact skill source, a saved prompt, and a project-relative reference. Rename and move the link, reload, and check all three items. Compare the source path and content hash before and after.
3. Try an editable source in two windows. Save an edit in one and submit the stale edit in the other. The second save should report the conflict and preserve the draft.
4. Add a prompt and skill to the draft tray. Open the native composer and check project, provider and content. Leave the composer unsent.
5. Export and review a pack. Check that referenced private files stay local. Confirm in a disposable checkout, inspect files using core skill discovery, and open the imported collection. Review and confirm the exact same bytes from the CLI and compare the receipts. Modify a disposable installed file and check that another review cannot overwrite it.
6. Check the collection-to-detail path at 708 px and 390 px. At narrow width use Back from the inspector and verify that the originating row receives focus.
