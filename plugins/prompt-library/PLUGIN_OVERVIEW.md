Find any prompt you have sent before, star the ones you reuse, and drop them back into the composer without retyping.

Disabled by default. Enable **Prompt Library** in Settings → Plugins or run
`omnyo plugin enable omnyo--prompt-library`.

With Skills 0.6.0 or later running, this plugin imports its starred prompts into Skills and forwards its existing commands and RPCs. Skills owns the prompt interface after migration succeeds. Without compatible Skills, the standalone behavior below remains available.

## What you get

- A **Prompts…** entry in the composer plus menu, also bound to **Ctrl+R** (rebind it as "Search prompts" in keyboard settings).
- A search box that finds previous prompts by words, word starts, abbreviations, or words with a typo as you type.
- **Starred** prompts pinned above **Recent** ones, most recently used first. Searching shows one ranked list: prompts that start with your query first, then the closest word matches, favoring prompts that started threads in the new-thread composer, follow-ups in a thread, and recent prompts.
- Scope toggles: **Thread**, **Project**, and **All** in a thread; **Project** and **All** in the new-thread composer. The last choice is remembered on this device.
- `omnyo prompts search|list|star|unstar` for the same data from the terminal.

## How it works

1. Press **Ctrl+R** in the composer, or open the plus menu and choose **Prompts…**.
2. Type to search. Click a prompt or use the arrow keys to preview it, **Tab** to switch scope, and **Enter** or **Insert** to insert. Moving the mouse leaves the selection unchanged.
3. Press **Cmd+S** (**Ctrl+S** elsewhere) or click the star to star or unstar the highlighted prompt. With text in the composer, **Star current draft** stars it.

If a search fails or takes more than 5 seconds, click **Retry** to repeat it without closing the picker or retyping. Previously loaded prompts stay available while searching or after an error.

Inserting into an empty composer restores the whole prompt, including mentions and attachments. Otherwise the prompt's text and mentions go where the cursor was. Starred prompts keep text and mentions; attachments are dropped.

Previous prompts come from Omnyo's prompt history: messages you sent yourself, not ones sent by agents.

## Credits

Maintained and extended by Omnyo, based on the [prompt-library plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/prompt-library). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
