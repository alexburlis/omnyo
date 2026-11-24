Open your Omnyo from a phone or another computer. Once this Omnyo is signed in to your Omnyo account, it answers at `https://<handle>.omnyo.link`, through the Omnyo relay, for anyone signed in to your omnyo.link account.

## What you get

- Remote access to the full Omnyo app through a tunnel. Your Omnyo makes an outbound connection, so you do not open ports or change your router.
- Port shares. Publish a local HTTP server, such as a dev server, at a share URL. The link opens from any device with your session.
- Pairing for the Omnyo mobile app with a QR code or a one-time code.
- An Omnyo connect section in Settings, with the connection state and the remote URL.

## How it works

Remote access uses the Omnyo account plugin. Sign in from Settings → Omnyo connect, Settings → Omnyo account, or `omnyo account login`. A pairing code from the omnyo.link dashboard also works: paste it in Settings or run `omnyo connect --code <code>`. Remote access starts as soon as the account is signed in, and connects with the server credential Omnyo account holds. The plugin reconnects after a drop, and signs out if omnyo.link no longer accepts the credential.

`omnyo connect off`, or the Remote access switch in the plugin settings, turns remote access off and keeps this Omnyo signed in; `omnyo connect on` turns it back on. `omnyo account logout` forgets the pairing. Disable the plugin to cut all remote access at once.

## For agents

Agents share managed previews in chat using the original loopback URL. Omnyo opens the link directly on the server’s machine and uses a private preview route on other devices. The `share-server-links` skill covers Connect port shares for links requested outside Omnyo. Other commands: `omnyo connect status`, `omnyo connect unexpose <port>`, `omnyo connect shares`, `omnyo connect servers`, and `omnyo connect machine-code`.

## Requirements

A omnyo.link account and the Omnyo account plugin. Share links open only for viewers with your omnyo.link session; they are not public. Mobile pairing is available under Mobile → Add mobile device.

## Credits

Maintained and extended by Omnyo, based on the [connect plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/connect). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
