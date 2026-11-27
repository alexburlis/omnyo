## Installed skills

Open **Skills** in the navigation rail. Search installed skills and saved prompts, inspect each source, and switch between projects and environments. Group skills, prompts and references in collections. **Export Markdown** downloads the selected source. **Export pack** includes a collection's skill packages and saved prompts.

## Import Markdown and packs

Drop a `.md` or `.omnyoskillpack` file on Skills, or choose **Import** to select it. Check the destination and preview the files before installing. Plain Markdown gets a skill name based on the filename. A valid `SKILL.md` keeps its contents. Installation preserves conflicting files already in the destination.

## Marketplace

Open **Marketplace** inside Skills to browse the live Omnyo catalog. Review an exact curated package when available, or review the listing's pinned Markdown. Workflows open Automations review and supported connectors open their settings.

**Curated skills** also appears under **+ → Find skills** in chat. Choose **Use once** to add an eligible skill to the draft for one message, or review its package for installation. Browsing and reviewing do not start a model turn.

The CLI exposes library and pack operations under `omnyo skill-discovery`. Use `omnyo skill` for individual installed skills.

## Prompts

Open **Prompt history** in Skills, or **+ → Prompts…** / **Ctrl+R** in chat. Search previous prompts, global starred favorites and saved/imported workspace prompts. Preview and insert text without sending it. Existing Prompt Library commands remain available after migration.

## Credits

The prompt picker, history search and ranking build on the [bb Prompt Library](https://github.com/get-bb/bb/tree/main/plugins/prompt-library) by Michael Yong and the bb contributors, extended by Omnyo. Its MIT license is retained in [LICENSE.prompt-library.txt](LICENSE.prompt-library.txt).
