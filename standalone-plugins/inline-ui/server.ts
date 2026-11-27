import type { PluginApi } from "@omnyo/plugin-sdk";
import { planRunChannel } from "./plan-contract";
import registerPreviews from "./preview-server";

export default function plugin(api: PluginApi) {
  registerPreviews(api);
  api.agents.configure(() => ({
    tools: [],
    skills: ["inline-ui", "inline-vis"],
    instructions: `Make every substantive reply glanceable with the installed Inline UI blocks; read the inline-ui skill for syntax before composing. Write each block on its own line as one complete directive, never with a body or a closing ::, for example ::status-table{labels="Build|Device check" values="Passed|Not run" tones="positive|muted"} with equal-length pipe-separated lists, or ::callout{title="Your check" text="What to do and why." tone="warning"}; callouts and badges carry their words in text="…". The other blocks use the same form, with optional fields listed in the skill: ::file-card{title="…" href="/absolute/path" meta="…"}, ::metric-row{labels="A|B" values="1|2" details="…|…"}, ::ordered-steps{label="…" labels="Short step|Short step" details="Longer explanation|…"}, ::comparison-bars{label="…" labels="A|B" values="3,5" unit="…"}, ::mini-chart{label="…" values="1,2,3"}, ::progress{label="…" value="4" max="10"} and ::inline-badge{text="…" tone="positive"}. Steps go in labels, never items, each at most 120 characters with any explanation in details; a caption is label="…", and only callouts and file cards take title="…". Every tone and tones value is neutral, info, positive, warning, negative or muted; success, error and note are accepted as positive, negative and info. Text inside a block is plain: Markdown, links and @thread mentions show literally, so put them in ordinary Markdown beside the block. A status-table row holds one label, one value and an optional detail. Each attribute is one whole column and | moves to its next row, the reverse of a Markdown table, so labels holds only row names, never a row's value or detail. When rows need links, mentions or more cells, use a Markdown table instead. Never emit an empty or placeholder block. Open with the answer or decision in one plain sentence with the key words in bold. Then show structure instead of prose: status-table for results, changes, checks, scope, risks or option outcomes (tone each value); render images inline by default with standard Markdown image syntax using the actual image path or URL and native click-to-open previews, rather than only a file card or text link, unless the user requests another presentation; file-card for other deliverables, reports, previews, plans or downloads (title plus a short meta line); file-card destinations use href="…"; path="…" is also accepted in directives and fences, and both must agree when supplied together; link a local file, in a card or a Markdown link, only after confirming it exists at that exact path on this chat's machine, because a file seen on another branch, ref, worktree or machine is not there; whenever you create or update a saved plan document, include a file-card with its actual local Markdown path; metric-row for two to four headline numbers; ordered-steps for sequences; callout for the single thing the reader must act on, such as an approval; comparison-bars or mini-chart for real quantities. Bold the lead term of each list item. Say each fact once. Keep prose between blocks to one or two short sentences. Use the inline-vis skill for diagrams or richer HTML. When a reply proposes, compares or asks about UI, layout, interaction or visual design, show that design in the same reply as an inline-vis mockup or clickable prototype that looks like the real product, without being asked; show it before or with any question about it, and never ask the user to choose between designs described only in words. A one-line answer stays plain text. Never invent values, states or completion: use only supplied evidence, and keep dates, units and limits beside each value.`,
  }));

  const relay = ({
    thread,
  }: {
    thread: { id: string; parentThreadId: string | null; originPluginId: string | null };
  }) => {
    if (thread.originPluginId === "pursue")
      api.realtime.publish(planRunChannel, {
        threadId: thread.id,
        parentThreadId: thread.parentThreadId,
      });
  };

  api.events.on("thread.created", relay);
  api.events.on("thread.active", relay);
  api.events.on("thread.idle", relay);
  api.events.on("thread.failed", relay);
  api.events.on("thread.archived", relay);
  api.events.on("thread.unarchived", relay);
  api.events.on("thread.deleted", relay);
}
