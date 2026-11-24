# Orca visual workflow UI proof

This bounded fixture renders the actual Browser Automation visual controls,
Glance result components and core image viewer in real Chrome. It uses production
RPC schemas and the real browser SDK attachment transport with synthetic fetch
responses. It does not verify production authentication or replace the separate
real Browser Automation DOM/capture smoke and native Electron capture proof.

Use the matching integrated core checkout and local Glance source. Reuse the
installed pinned DevBrowser and Chrome; no dependency install is needed. Record
the browser scratch owner before running and keep test logs outside scratch.

```sh
export PATH=/Users/developer/.nvm/versions/node/v22.23.4/bin:$PATH
ORCA_UI_GLANCE_SOURCE=/absolute/plugins-review/glance corepack pnpm exec vite --config apps/app/tests/qa/orca-visual-workflow/vite.config.mjs --host 127.0.0.1 --port 48139
node --conditions=source --import tsx apps/app/tests/qa/orca-visual-workflow/proof.mjs /absolute/dev-browser-bin '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' http://127.0.0.1:48139 /absolute/evidence /absolute/owned-scratch-parent /absolute/plugins-review/glance
```

Reserve an unused port and one shared verification slot. Startup must finish
within 60 seconds. The browser proof has a 50-second total signal and a
43-second script bound; run it under the task's 60-second command guard. Stop
only this fixture server afterward. The producer closes its exact browser and
daemon, removes the profile/runtime scratch and retains four bounded JPEGs.
Vite uses the task-owned `../ui-vite-cache` beside the review checkout; record
that cache before startup and remove it after the fixture server stops.

The proof drives desktop and touch phone viewports. It checks letterboxed element
selection, exact target/thread routing, project-owned multipart upload, foreign
composer preservation, stale-note recovery, viewport note retention, collapsed
and offscreen lazy image loading, explicit cross-project ownership, real image
viewer keyboard/focus behavior, unchanged native attention/read state and object
URL cleanup. It records input hashes before and after execution. Chromium phone
emulation does not establish Safari behavior.

The retained first passing receipt mislabeled elapsed milliseconds as `seconds`.
`ui-metadata-correction.json` records that unit correction without changing the
original execution hashes. Its mobile Glance image caught the existing viewer's
closing animation. The harness now waits for that exit layer before later shots;
the metadata and screenshot-readiness edits were not a second behavioral run.
