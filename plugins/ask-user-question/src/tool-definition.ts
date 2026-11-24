export const TOOL_DESCRIPTION = `Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Reserve this for decisions where the user's answer changes what you do next — not for choices with a conventional default or facts you can verify in the codebase yourself. In those cases pick the obvious option, mention it in your response, and proceed.

For visual decisions, put the actual design in each single-select option's preview. Use a Markdown image such as ![Launchpad layout](/absolute/path/launchpad.png) or an HTTPS image URL. For formatted comparisons use a short HTML fragment starting with a tag, such as <h3>Launchpad</h3><ul><li>Open reviews</li></ul>. The panel sanitizes HTML. Use an image for designs that depend on custom CSS. Plain text and code keep their spacing. The preview appears beneath the selected option. Omit it for choices that labels and descriptions explain.
`;

export const TOO_FEW_OPTIONS_MESSAGE =
  "This call included a question with fewer than 2 options, so it was rejected and the person never saw it. A question with a single option has no decision in it. Do not retry this call and do not invent a filler second option. Instead, state the one path you were going to offer as the approach you are taking, then continue with the task. If this call also contained questions with 2 to 4 options (each with distinct labels), you may re-ask those questions alone in a new call. Ask a question only when the person has at least two genuinely distinct choices.";

export const NOT_UNIQUE_MESSAGE =
  "Question texts must be unique, option labels must be unique within each question";

export function buildTimeoutMessage(elapsedMs: number): string {
  return `No response after ${Math.round(elapsedMs / 1000)}s — the user may be away from keyboard. Proceed using your best judgment based on the context so far; you can re-ask this question later if it's still relevant.`;
}
