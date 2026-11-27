# Branch Tree

One click creates a native empty chat fork and opens it in Omnyo. The sidebar keeps
first branches aligned with their source and nests further branches. Existing
forks work automatically. There are no background services or provider resources.

Frontend registrations: `branch-tree/branch` (chat header) and `branch-tree/tree`
(sidebar thread list). The backend selects the tree only on fresh installation.
The plugin reads native sidebar data, uses the public fork/navigation APIs, and
stores only browser collapse preferences. It changes no conversation history,
provider settings, checkout, or other plugins' header selection.
