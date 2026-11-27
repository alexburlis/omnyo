# Design boundary

Omnyo owns context, permissions and delivery. FastLoop owns browser execution and verification.

The adapter resolves context once through current thread/project/environment/host records and a selected-host canonical workspace probe. All runtime RPC calls carry that binding and an explicit host ID. Page text, tool JSON and model output do not select an execution host.

Native tool calls use framework thread context. Owner CLI/UI calls use explicit selection with conflict checks. Run/session ownership records bind both paths to the same context; owner selection is not a native-tool principal.

The adapter's persisted map/outbox stores only ownership and delivery. It does not implement FastLoop's journal, model routing, browser driver, verdict reducer or migrations.

The source UI follows Omnyo tokens and reuses the canonical details panel. Source checks do not establish rendered, installed, cross-host or live behavior.

## Prepared payload boundary

The development preparer validates opaque package bytes before writing an ignored payload module. A committed final lock must bind package, manifest, compatibility, protocol and native-archive hashes. The committed lock pins the prepared private candidate.

The host entry imports the verified payload through the existing host build. Its runtime owner atomically materializes under plugin data storage, verifies warm materializations and resolves an explicit compatible Node 24 executable. The adapter must not use a PATH FastLoop fallback, perform a latest-version fetch or infer transfer from a host bundle alone.

## Run details

The thread's FastLoop panel is the canonical entry. It lists only that thread's
stored runs. An assistant can also render `::fastloop-run{run="RUN_ID"}`; the
directive uses the containing message's thread and never trusts an attribute to
select another thread or execution host.

New elements use Omnyo's canvas, ink, border, radius and text tokens. The panel has
one column, wrapping action rows and bounded image/text previews at narrow widths.
It preserves adjacent Omnyo layout and colors.

Show tested scope, each check's actual verdict, model-assessed visual judgments,
partial exploration and limitations. An exploratory completion cannot become a
passing application check. Run/build identities remain available with the evidence.

Evidence previews request owned chunks, validate run/evidence identity and full
SHA-256, and accept only raster images or inert text. They never navigate to a
host-local file URL or execute page-supplied markup. A preview refusal retains the
underlying result. Screenshot masking is not inferred from a text-only redaction.

Mounted active viewers use a bounded ten-second event wait and refetch the
canonical terminal result. Unmount stops new waits; the SDK's already-dispatched
read-only wait can finish within its bound. No viewer captures screenshots or
calls a provider. Closing a preview revokes its Blob URL.

Prepare recheck inserts a draft into the matching thread's composer. The coding
agent must supply the actual change context and preserve the prior session and
check meanings. The UI does not submit a message, invent a build or silently
create a replacement session.
