# Omnyo demo server

A read-only Omnyo server with three sample threads. App reviewers add `https://demo.omnyohq.com` in the Omnyo app and can browse threads without a real server. It runs on Chibistack as the app `omnyo-demo`.

- `server.mjs` serves the web app from `public/`, the API fixtures and a `/ws` socket that answers pings. It uses only Node built-ins.
- `fixtures.mjs` holds the sample data. Unsupported actions, such as sending a message, return a 501 error that says the server is read-only.
- `test.mjs` is the offline `/app/test` the release workflow runs.

This folder has no `package.json`, so it stays outside the pnpm workspace and Turbo graph. The image builds the web app and the Thread list plugin from the commit it releases.

## Run it locally

1. Run `pnpm exec turbo run @omnyo/app#build @omnyo/plugin-build#generate @omnyo/plugin-sdk#build` from the repository root, followed by `pnpm exec tsx apps/demo-server/build-thread-list.mjs` to build the browser plugin.
2. Copy the three `.mjs` files to a scratch folder. Copy `apps/app/dist` to `public/` there, and `app.js`, `app.css` and `app.meta.json` from `plugins/thread-list/dist` to `public/demo-plugins/thread-list/`.
3. Run `node test.mjs`, or `PORT=8080 HOST=127.0.0.1 node server.mjs`.

## Release

The production host builds this app from source. It follows the `demo-release` branch of this repository, so a fast-forward push of that branch to a reviewed `main` commit deploys the demo. The host checks that the new tip descends from the live commit, builds the image, runs `/app/test` and switches traffic after the readiness check. The previous image stays on the host for rollback. After a release, check `https://demo.omnyohq.com` and one sample thread.
