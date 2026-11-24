---
name: agent-annotations
description: Add element notes and cropped screenshots in desktop Design Mode, capture a paired result, or revise immutable saved annotation context.
---

Enable Agent Annotations in Settings → Plugins. In a desktop Browser tab, activate Annotate elements, select an element and add its comment. Click a numbered pin to edit it; Save or Ctrl+Enter (Command+Enter on macOS) records a new immutable revision. Blank notes cannot be saved. Delete removes that pin and its current unsent mention. Successful sends or queueing clear only the exact accepted note revisions; unrelated messages, failed sends and later edits keep their pins.

Turn on Design Mode (the paintbrush) to attach a cropped screenshot with each note. Captures include bounded styles and best-effort React/source hints, map document scroll into the actual bitmap, and refuse changed pages rather than attaching the wrong crop. Failed capture/upload keeps the note and offers Retry capture. Each image is uploaded to the owning project before it enters the draft, so another machine can read it after the browser closes. Batch up to 24 notes, then send them through the ordinary composer.

After the change, return to the same route, scroll position and viewport, then select Capture result for visual review. The composer receives the immutable Before image and a fresh Result image, paired by visual request ID. Use the ordinary image previews to compare them. A hot reload may create a new document; each individual capture still validates its own element and geometry. The baseline is never overwritten. Locator and React/source hints are context, not guaranteed source mappings.

Toolbar remounts recover notes and the last 24 visual requests from bounded immutable-context references scoped to the exact Omnyo thread and tab. The app session keeps these references; image bytes stay in project attachments. Accepted batches release the active-note limit. Capturing another result replaces that request's unsent result mention and image instead of accumulating copies.

Saved immutable contexts remain available to earlier messages. `saveRevision` accepts the annotation record and returns an immutable revision ID. `revise` takes that revision ID and a nonblank comment up to 4000 characters and returns a new ID. Update the unsent mention to that returned ID; old IDs never change. `readRevisions` accepts up to 24 revision IDs and returns those exact saved records for app-session recovery.

```sh
omnyo plugin rpc call agent-annotations revise --input-file annotation-revision.json --json
```

```json
{ "id": "immutable-revision-id", "comment": "Make this button green" }
```

The legacy `save`/`update` RPCs remain for pre-Design-Mode records. They cannot overwrite immutable revision contexts. CLI browser capture and SDK automation continue through the existing `experimental_desktopBrowsers.captureTab` route. No capture acquires a new browser controller.
