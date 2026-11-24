Needs You combines questions, sidebar attention highlights and callback relationships in one Omnyo plugin. Omnyo owns the questions, pending interactions, callbacks and status; the plugin displays that state.

## Questions

Agents on providers without a native question tool open questions in Omnyo's native panel. Required answers block the dependent action; optional questions let the agent continue with a reversible default. A question supports two to four choices, multiple selections, free text and option previews.

The tool returns immediately. Questions stay open until answered, skipped or withdrawn. Answers enter Omnyo's durable message queue once and steer the existing task. Skip supplies no answer or approval. Questions from a child chat go to its parent or launching chat. Older question cards retain their renderer until they drain.

## Sidebar attention

Highlight chats that need input, have an unread result, have queued messages or wait for a callback. Working chats are dimmed. Callback groups show related chats with dots and lanes; hover or focus a chat to trace its dependencies.

Settings control each treatment and its intensity. Disabling a visual treatment preserves native questions, banners, indicators and callback records. The stable plugin ID remains `ask-user-question`, so CLI settings use `omnyo plugin config ask-user-question`.

Older `needs-you` preferences are adopted once into missing settings when the host supports this migration. Existing settings in this plugin take precedence. The retired companion becomes a compatibility entry without a second overlay; update or disable an older companion before enabling both.

## Credits

Maintained and extended by Omnyo, based on the [ask-user-question plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/ask-user-question). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong. Sidebar attention and callback visuals were developed for Omnyo's Needs You companion plugin.
