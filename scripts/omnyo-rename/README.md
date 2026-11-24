# Omnyo source transformer

The transformer edits a task-owned source candidate. It never migrates a live
profile, database, credential, OS service or provider setting. Use the state
owners before changing corresponding emitters.

The planning specification in `docs/omnyo-migration/rename-rules.json` is not an
executable operation list. Materialize exact operations from inspected source.
Unclassified candidates and conflicts block apply.

## Bound operations

An executable input has this shape:

```json
{
  "schema": 1,
  "candidate": {
    "root": "/absolute/task-owned/candidate",
    "owner": "thread-id"
  },
  "operations": [
    {
      "id": "package-config",
      "rule_id": "R01",
      "ledger_ids": ["PKG-001"],
      "proof_ids": ["V01-source-transform"],
      "migration_ids": [],
      "owner": "thread-id",
      "selector": {
        "kind": "packageName",
        "file": "packages/config/package.json",
        "before": "@bb/config",
        "after": "@omnyo/config"
      }
    }
  ]
}
```

Each operation ID is unique. Serialized property edits require the corresponding
state migration IDs. Operations marked `blocked` cannot enter an apply plan.

| Selector          | Exact context                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packageName`     | The JSON package `name` value.                                                                                                                                |
| `moduleSpecifier` | Exact module values in imports, exports, dynamic imports, `require`, import types and module declarations.                                                    |
| `symbol`          | `file`, original identifier `position`, `before` and `after`; TypeScript language-service declaration rename across the owned graph.                          |
| `jsonPath`        | `path` as property-name components, `field` as `key` or `value`, and exact JSON `before`/`after` values.                                                      |
| `literal`         | Exact script literal with `context` of `string`, `property` or `jsxAttribute`.                                                                                |
| `format`          | CSS parser context `selector`, `property` or `value`; HTML parser context `attribute` plus its exact `attribute` name.                                        |
| `span`            | Exact `start`, `before`, `after` and a named `context` for reviewed prose or shell source. This selector never searches for replacements.                     |
| `path`            | Original exact file or directory `file` and `target`; nested moves compose from original paths.                                                               |
| `preserve`        | Exact file/token context, preservation `reason`; optional exact `start`. Whole-file or opaque preservation requires `wholeFile: true` and the exact `digest`. |

Preservation reasons are the six classes in the migration specification.
`narrow-versioned-legacy-input` also requires `input_version` and
`removal_condition`. A preservation selector that matches nothing is refused.

Symbols use the pinned TypeScript service, with source export maps from owned
package manifests. Existing aliases with deliberately different exported names
remain separate declarations. Local shorthand renames retain their serialized
key; the independent check reports that key until its separate migration or
preservation is classified. Target names already bound in declaration or consumer
scope are refused.

CSS uses the existing `apps/mobile` PostCSS owner. HTML uses the existing
`apps/server` parse5 owner. Their dependencies must be installed through the
workspace. Unsupported parser contexts refuse rather than becoming text search.

## Bounded waves

A `defer` selector records an exact untouched file for a later wave. It requires
`file`, its SHA-256 `digest`, a later `phase` from `P0` through `P7`, and a concrete
`reason`. The operation's `owner` retains delivery responsibility. It is a pending
work disposition, not a preservation exception.

An exact text-range deferral additionally carries `start` and `length`. It covers
only those original characters; a partial token cannot classify the rest of that
token. Selected edits cannot overlap a deferred range. Whole-file deferrals keep
the original prohibition on all edits. Any deferral prohibits moving its file.

`pathOnly: true` defers only the exact pathname. It permits disjoint bound text
edits but cannot classify any source token or authorize moving that path.
Whole-file pending inputs are hashed and bound without AST discovery. They
cannot receive edits, and the final independent check still scans them and
fails while they remain pending. Protected source inputs receive measurements
only, require their exact pending owner, and cannot be edited or moved.

Every valid UTF-8 non-binary source is independently scanned, regardless of its
file extension. Script candidates bind raw source positions across escapes, JSX
entities and interpolated template segments. Encoded brand tokens remain explicit
whole-token candidates when a smaller raw span cannot be proven.

The complete source universe remains enumerated and digest-bound. Unknown candidates
outside those exact deferred files still block apply. Changing a deferred file
after planning refuses apply before selected source writes. Plans report deferred
candidates separately. The independent `check` always returns `ok: false` while
any deferrals remain, even if the selected wave transformed successfully.

## Commands and recovery

Run from the candidate or pass `--root`. Reports and journals remain outside the
candidate source.

```sh
node scripts/omnyo-rename.mjs plan --manifest /owned/operations.json --output /owned/rename-plan.json
node scripts/omnyo-rename.mjs apply --plan /owned/rename-plan.json --journal /owned/rename-journal.json
node scripts/omnyo-rename.mjs resume --plan /owned/rename-plan.json --journal /owned/rename-journal.json
node scripts/omnyo-rename.mjs check --plan /owned/rename-plan.json --output /owned/rename-check.json
```

The plan binds the Git revision, index, entire tracked/untracked source path
universe, file modes/digests, exact parser edits and final output digests.
Git-ignored build outputs need their separate generated-output owners. Protected
credential/database paths and symlinks cannot become transformation inputs.

Apply validates the whole bound source before writing its journal. Each selected
file passes through a journal-owned staging path. The journal and staged writes
are flushed before publishing. Resume accepts only expected-before or
expected-after bytes; a third digest or ambiguous source/staging state refuses.
An interrupted unflushed `.pending` file refuses visibly for reconciliation.
No stale backup replaces newer source bytes. Empty source directories are removed
only after their known file moves complete.

`check` validates the expected output path/digest universe and independently
rescans remaining branded source tokens against exact preserved ranges. Matching
bytes establish source transformation, not behavior, asset approval, installation
or state continuity. The product verification matrix remains required.
