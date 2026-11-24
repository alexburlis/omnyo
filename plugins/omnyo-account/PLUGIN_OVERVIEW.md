Sign this Omnyo in to your omnyo.link account once. Remote access uses that account.

## What you get

- A Settings section with your avatar, GitHub login, handle, this server's label, and a Sign out button.
- Sign-in from any device. Omnyo shows a code and an omnyo.link link; you approve it in a browser, even when Omnyo runs on a headless or remote machine.
- One place that holds this server's omnyo.link credential. Other plugins make requests through it and never see the credential.

## How it works

Click Sign in, or run `omnyo account login`. Open the omnyo.link link, sign in with GitHub, pick an address if you have none, and approve this Omnyo as a new server or as a replacement for one you already have. Omnyo picks up the approval on its own. If you have a pairing code from the omnyo.link dashboard, paste it in Settings or run `omnyo account login --code <code>`.

`omnyo account status` shows the account and `omnyo account logout` signs out. Signing out revokes the server credential on omnyo.link, so remote access stops until you sign in again. Add `--json` to any command for machine-readable output.

## Requirements

A GitHub account to sign in to omnyo.link. An imported server keeps Omnyo account off until you run `omnyo server allow-connect`.

## Credits

Maintained and extended by Omnyo, based on the [bb-account plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/bb-account). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
