# Source provenance

The package started from the supported `omnyo plugin new fastloop` scaffold, SDK `0.6.42`. Example todo/UI source was removed.

Anti-slop is the repository's shared `resources/tools/oxlint/anti-slop` copy, Git tree `ac9c8accaef9b2e4116948aa565f3dc3c9fd18dc`. Its source, vendor license and rules remain unchanged. Oxc configuration follows the Workspace GitHub plugin. Oxlint and `@oxlint/plugins` are both pinned to `1.87.0`; Oxfmt is `0.72.0`.

No FastLoop engine source or model/browser dependency is vendored here. Runtime payload provenance belongs to the standalone FastLoop runtime's qualified payload manifest.
