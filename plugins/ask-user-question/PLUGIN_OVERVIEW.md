Agents on providers without a native question tool open questions in Omnyo's native panel. Required answers block the dependent action; optional questions let the agent continue with a reversible default.

## What you get

- A question card in the thread with two to four options per question. Each option has a label and a description.
- Up to four questions in one card. A question can accept one answer or several answers.
- An "Other" field on every question for free-text input.
- An optional preview under an option, for example a code snippet or a layout mockup.

## How it works

The tool returns immediately. Questions stay open until answered, skipped or withdrawn. Answers enter Omnyo's durable message queue once and steer the existing task. Skip is silent and supplies no answer or approval. Questions, revision checks and callback status remain available when visual plugins are disabled. Existing older question cards keep their renderer until they drain.

Questions from a child chat, or from a chat another chat started, go to that parent or launching chat instead of the owner, and its answer arrives as a message in the asking chat.

The tool is added to providers that do not rely on their own blocking question tool, including Claude Code, whose own tool Omnyo redirects here outside plan mode. Providers that rely on their own tool keep their native behavior.
