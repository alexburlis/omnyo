# Exact API lookup and distribution

## Looking up the exact API

This skill is a guide. Read the selected runtime's declarations for exact signatures.

1. Run `omnyo plugin types` in the plugin directory, or pass its path. The
   command copies the verified private `@omnyo/plugin-sdk` archive into `vendor/`
   and pins its exact `file:./vendor/<archive>.tgz` dependency. Run `pnpm install`
   afterward. `--check` compares the selected archive bytes and dependency pin
   without writing. It does not fetch a public npm SDK or rewrite vendored
   declarations.
2. Read `node_modules/@omnyo/plugin-sdk/bundled-types/omnyo-plugin-sdk.d.ts`.
   The app and host entries use `omnyo-plugin-sdk-app.d.ts` and
   `omnyo-plugin-sdk-host.d.ts`. Existing plugins with `types/*.d.ts` require
   `omnyo plugin migrate` first. Migration displays its plan, asks before applying,
   and requires `--yes` without interactive stdin. It preserves the original
   declarations in `vendor/legacy-plugin-sdk-v1`. Migrate only an authorized plugin.
3. **`git clone --depth 1 https://github.com/get-bb/bb`** provides upstream
   reference implementations in `packages/plugin-sdk/src/`,
   `apps/server/src/services/plugins/`, and `plugins/`. Private Omnyo extensions
   follow the selected private archive and matching private source.

The declarations and source are the contract. Minified application bundles are
not API documentation.

## Distributing a plugin

Users can install third-party plugins directly from a local path, npm package,
or Git repository:

```sh
omnyo plugin install ./omnyo-plugin-notes
omnyo plugin install npm:omnyo-plugin-notes@^1.0.0
omnyo plugin install https://github.com/acme/omnyo-plugin-notes
omnyo plugin install git:https://github.com/acme/omnyo-plugin-notes.git@main
omnyo plugin install git:https://github.com/acme/omnyo-plugin-notes.git@^1.2.0
```

A bare HTTP(S) repository URL tracks its default branch. Use the `git:` form
with an explicit branch, tag, or commit when that tracking intent matters.
Install and update run third-party code with full trust. Interactive commands
show the resolved source and ask for confirmation. Pass `--yes` only after the
user confirms that exact source and version.

### Releasing a git plugin with semver tags

Tag each release `vX.Y.Z` and users can install a range instead of a ref:
Omnyo reads the repository's tags, installs the highest release the range allows,
and `omnyo plugin update` moves them to later releases in the same range.
Prereleases stay out unless the range names one. Give each plugin of a
multi-plugin repository its own tag prefix — `notes/v1.2.3` — and users add
`--tag-prefix notes/`.

Omnyo records the tag it installed together with the commit that tag pointed at,
and refuses the plugin if that tag is ever moved to another commit. Publish a
fix as a new version rather than retagging.

### Several plugins in one repository

Keep each plugin in its own directory with its own `package.json`, then index
the directories in a `.omnyo/plugins.json` collection manifest at the repository
root:

```json
{
  "$schema": "https://app.omnyo.link/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "plugins": [
    { "name": "notes", "source": "./plugins/notes" },
    { "name": "status", "source": "./plugins/status" }
  ]
}
```

Each `source` is a repository-relative directory that starts with `./`. The
file is an index only — it never overrides a plugin's identity, branding,
entry points, or engine ranges. Users install one plugin at a time:

```sh
omnyo plugin install git:https://github.com/acme/omnyo-plugins.git@main --plugin notes
omnyo plugin install git:https://github.com/acme/omnyo-plugins.git@main --subdirectory plugins/notes
omnyo plugin install path:. --plugin notes
```

`--subdirectory` works without a collection manifest; `--plugin` resolves an
entry name from it. If the repository is not itself a plugin, an install with
neither flag fails and lists the entry names.

### Publishing your own marketplace

A marketplace is one `marketplace.json` file. It lists plugins with their
store branding and their npm or git source; it never hosts plugin code, and
installing an entry runs the same install pipeline a direct install runs.

```json
{
  "$schema": "https://getbb.app/schemas/marketplace.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "displayName": "Acme Plugins",
  "description": "Plugins the Acme team maintains.",
  "plugins": [
    {
      "id": "notes",
      "displayName": "Notes",
      "description": "Keep notes beside a thread.",
      "icon": { "url": "./icons/notes.svg" },
      "tags": ["notes", "interface"],
      "author": { "name": "Acme", "github": "acme", "url": "https://acme.dev" },
      "source": {
        "git": {
          "url": "https://github.com/acme/omnyo-plugins.git",
          "subdir": "plugins/notes",
          "range": "^1.0.0",
          "tagPrefix": "notes/"
        }
      }
    }
  ]
}
```

The schema is strict: an unknown field rejects the whole document, and the
last catalog Omnyo validated keeps serving. `name` is the marketplace's identity
and must be unique on the user's machine; `omnyo-official` is reserved.
Compatibility belongs in each plugin package manifest. Icons are `.svg`,
`.png`, or `.webp`, either an absolute https URL or a path relative to the
manifest — Omnyo fetches and validates them server-side and serves them from its
own origin.

Host it three ways, and users add whichever fits:

```sh
omnyo marketplace add https://plugins.acme.dev/marketplace.json
omnyo marketplace add git:github.com/acme/omnyo-marketplace@main
omnyo marketplace add git:github.com/acme/agent-plugins@main --subdirectory omnyo
omnyo marketplace add path:/work/acme-marketplace
omnyo marketplace list
omnyo marketplace refresh acme-plugins
omnyo marketplace remove acme-plugins
```

`list` shows configured catalogs. `refresh` updates discovery metadata and
icons without installing code. `remove` forgets the catalog, while installed
plugins continue as direct installs.

An https marketplace is re-read with a conditional request; a git one is
cloned into a throwaway checkout each refresh, with `marketplace.json` and any
relative icons read from the repository root, or from the directory named by
`--subdirectory <relative-path>` when the repository keeps its Omnyo files apart
from other content. `source.git.subdir` in an entry stays relative to the
repository root. Prefer git tag ranges over
pinned refs so a release reaches users without a catalog change. Before
installing from a marketplace, Omnyo resolves and shows
the true source — including the exact release tag and commit a range lands
on — so keep your listed URL, subdirectory, and range honest.

Omnyo's bundled plugins ship inside the selected private runtime.

### Store listing text

A store listing has two text fields. The short `omnyo.description` in
package.json is the one-sentence hook. It appears on every browse card and as
the lead paragraph on the detail page. Keep it under about 140 characters.
State the outcome the user gets.

`PLUGIN_OVERVIEW.md` beside package.json holds the long-form description. The
detail page shows it in an Overview section under the lead paragraph.
`omnyo plugin new` scaffolds one, and a plugin that is only installed from
a local path or a private source still reads better with one.

The file is the same claim as `omnyo.description` at length: the same outcome, the
same surfaces, no capability the short text does not imply. Treat the two as
one text in two lengths. Whenever you change `omnyo.description`, or add or remove
a surface, update this file in the same change so the lead paragraph and the
Overview section never disagree.

A marketplace entry references the file with
`"overview": "./overview/<plugin-id>.md"`. A bundled Omnyo plugin uses the same
file, and the omnyo-official generator folds it into the built catalog.

Follow these rules. Marketplace CI rejects a file that breaks one.

- UTF-8 text with a maximum of 4000 characters. Aim for 700 to 1800.
- Headings, paragraphs, emphasis, strong text, strikethrough, inline code,
  code blocks, blockquotes, lists, thematic breaks, and links only.
- No raw HTML, images, tables, footnotes, or task lists. Put images in
  screenshots instead.
- Each link is an absolute https URL. The store opens it in the browser.
- Use `##` headings for sections. The page renders each heading as a small
  uppercase label. Do not start with a `#` title, and do not repeat the short
  description as the first sentence.

Lead with the outcome, then sections such as What you get, How it works, and
Requirements. Name every cost: an external service, an account, a separate
install, or a limited operating system. Name agent surfaces with their exact
tool or `omnyo` command names in inline code.
