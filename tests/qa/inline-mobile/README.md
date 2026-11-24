# Inline preview browser proof

This fixture mounts the production Inline Vis registrations and production
MarkdownPreview with deterministic local RPC data. It never starts Omnyo, opens an
account, reads an Omnyo store or requests provider work. Its navigation and clipboard
boundaries record calls. The browser is a fresh headless Chrome profile.

Finite failures, authored before the port:

- A wide table expands the page, wraps its headers, or cannot scroll with a focused arrow key.
- A preview exceeds 70svh, including in landscape, or HTML loses content-driven height.
- Markdown loses Show more, remembered expansion, or contained keyboard scrolling.
- A long path hides the filename, and copy/open/source/expansion controls are smaller than 44px.
- An iframe gains form or same-origin capabilities.
- Fenced HTML loses its source toggle, streaming status, or unclosed-code behavior.
- A viewport run makes a request outside the local fixture origin.

The same cases run at 320×740, 390×844, 768×1024, 1440×900 and 844×390.

After the parent admits a compiler/UI job, serve the fixture using the app's
installed Vite toolchain:

```sh
pnpm --filter=@omnyo/app exec vite --config ../../tests/qa/inline-mobile/vite.config.ts --host 127.0.0.1 --port 49175
```

Run the reusable proof with an existing Playwright module and an owned evidence
directory; the runner does not install dependencies or browsers:

```sh
node tests/qa/inline-mobile/proof.mjs /absolute/path/to/playwright/index.mjs http://127.0.0.1:49175 /absolute/path/to/evidence
```

The runner records source hashes, measurements, passed actions and JPEG screenshots
in result.json. A failure writes failure.json and exits nonzero. Read the images
as well as the metrics. This establishes production-component Chrome behavior,
not Electron/native-app, physical touch or full Omnyo startup behavior. Close the
fixture server after its last proof; retain the result and reviewed screenshots.
