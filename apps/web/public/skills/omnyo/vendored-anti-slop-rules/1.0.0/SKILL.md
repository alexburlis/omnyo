---
name: vendored-anti-slop-rules
description: Install or update a repository-owned lint rule pack while preserving local changes, compatible tooling, and upstream notices.
license: MIT
---

# Vendored anti-slop rules

Use this skill when a project wants to own a lint rule pack that catches specific recurring code defects. It contains a maintenance method, not a bundled plugin or a list of universally correct rules. The MIT license for this text does not relicense any rule code you later obtain.

## Establish what is installed

Inspect the target's instructions, working tree, package manager, lint configuration, and referenced plugin entry points. Follow renamed paths and aliases. A missing familiar directory does not prove the pack is absent.

For an existing pack, identify three inputs before editing:

- The exact pristine upstream revision used by the installed copy.
- The current repository copy, including local edits and disabled rules.
- The exact proposed upstream revision and its license notices.

If the base cannot be recovered, record that limitation. Compare file by file and preserve local changes for review; do not pretend a two-way replacement is a clean merge. For a new installation, use a new agreed destination and refuse to overwrite an existing directory.

## Check rights and provenance

Obtain code only from a source the user is authorized to use. Inspect licenses before copying. A pack can include code from several authors under different licenses. Keep each applicable license, copyright notice, attribution, and upstream provenance with its files. Do not replace all notices with the destination project's license.

Keep a small record beside the pack, for example:

```text
Pack: fictional-lint-pack
Upstream revision: fixture-revision-01
Source: https://lint-pack.example/source
Destination: tools/lint/fictional-pack
Local changes: adjusted one diagnostic for this project's vocabulary
Third-party notices: retained beside their corresponding files
```

This record is illustrative. Use a verifiable commit, release artifact hash, or preserved pristine snapshot for a real installation. A current branch name is not a durable base.

## Integrate deliberately

Read the chosen Oxlint release's documented JavaScript-plugin interface and the pack's compatibility requirements. Check installed versions and the lockfile before changing dependencies. Pin compatible runtime and plugin-helper versions as required by that release; do not assume independently latest packages work together.

Register the actual entry point through the repository's existing configuration. Merge plugin entries, rule severities, and exclusions without discarding earlier choices. Scope rules to code they understand. Exclude generated or third-party files when appropriate, but do not hide owned application source merely to get a pass.

Enable a rule because the project wants the constraint and has examples of the defect. Treat framework-specific or library-specific rules as opt-in for projects that use that library. Explain semantic tradeoffs before accepting a broad automatic rewrite.

## Update with a three-way comparison

Compare old upstream to new upstream to understand incoming changes, then apply those changes to the local copy. Preserve local rule behavior, diagnostics, tests, and configuration unless the user asked to change them. Resolve overlapping edits explicitly. Update provenance only after the installed files match the recorded result.

Do not claim a syntax rule proves a broader property. For example, recognizing a direct accumulator copy does not establish that all indirect quadratic operations are absent. Record the rule's supported forms and meaningful limitations.

## Verify behavior

Use the repository's normal lint entry point and focused rule tests. Each changed rule needs a small invalid example that triggers the intended diagnostic and a valid example that remains accepted. For autofixes, inspect the result, run it through the formatter, and confirm a second fix-and-format pass makes no change. Include a semantic check when a rewrite can affect evaluation order or runtime behavior.

Run the relevant typecheck or build after integration. Report pre-existing application findings separately from integration failures. Do not weaken severity, add casts, or suppress diagnostics to disguise an installation problem.

Finish with the source revision, installed paths, preserved local differences, retained notices, dependency changes, and check results. Leave external publication or an unrelated codebase cleanup outside the task unless requested.
