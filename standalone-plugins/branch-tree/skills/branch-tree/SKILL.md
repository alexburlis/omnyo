---
name: branch-tree
description: Explain Branch Tree's one-click chat action and nested sidebar view.
---

# Branch Tree

The **Branch** button in a chat header creates an empty native fork, opens it,
focuses its composer, and selects the tree sidebar.
Sidebar rows and menus offer the same action. First branches align with their
original; further branches nest under the chat they came from. Existing forks
are grouped through Omnyo's native `sourceThreadId`.

Choose Branch Tree in Settings → Appearance → Sidebar. The tree options menu
can restore Omnyo's project view, expand all, or collapse branches.

Forks inherit the provider, conversation context, execution settings, and source
checkout. They do not create Git branches or worktrees or send a prompt. The
source needs a provider session and ready environment. Report a failed fork
honestly; do not substitute an unrelated empty chat for it.

Use `omnyo plugin reload branch-tree` after editing and building the local source.
There is no plugin CLI or background service. Do not branch, send prompts, or
modify other chats without the user's authority.
