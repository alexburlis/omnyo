# Omnyo website release entry

The public website at `https://omnyohq.com` is the TanStack Start app in
`apps/web`. This folder keeps only what the production host builds and runs:

- `Containerfile`: builds `apps/web` and runs it as a Node server. It sets the
  website's public Sentry DSN for production builds; other builds report nothing.
- `.containerignore`: limits the build context to the files the build reads.
- `scripts/chibistack-test.mjs`: the offline image test at `/app/test`.

## Image contract

- The server listens on container port 8080 as UID 65532.
- `GET /api/v0/health` returns `{"ok":true}` for readiness.
- The root filesystem is read-only. The only writable mount is
  `/app/apps/landing/.next/cache`, which the server does not use.
- The server loads `/run/secrets/app.env` if it exists. The site needs no
  secrets.
- `/releases/latest.json` stays as the static version 0.1.17 updater manifest
  that old Tauri clients still request. It is not a release of the current
  Omnyo application.

## Develop and test

From the repository root:

```sh
pnpm --filter @omnyo/web dev
pnpm exec turbo run build --filter=@omnyo/web
pnpm --filter @omnyo/web start
```

To run the image test against a local build, copy `apps/web/dist`,
`apps/web/server.mjs` and the test script into one folder. Then run
`SITE_TEST_ROOT=<folder> SITE_TEST_PORT=<free port> node <folder>/test.mjs`.

## Release

The production host builds this app from source. It follows the
`landing-release` branch of this repository, so a fast-forward push of that
branch to a reviewed `main` commit deploys the website:

1. Within about a minute the host reads the new tip, checks with GitHub that it
   descends from the live commit and fetches it.
2. The host builds the image, runs `/app/test`, scans it, switches traffic after
   the readiness check and drains the old container. The previous image stays
   on the host for rollback.
3. Verify the change on https://omnyohq.com itself; `/api/v0/health` only proves
   that some release is serving.

A refused or failed commit is not retried until `landing-release` moves again.
Only fast-forward `landing-release` to commits that are already on `main`.
