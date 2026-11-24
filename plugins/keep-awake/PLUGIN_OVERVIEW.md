Stop your Mac from going to idle sleep while Omnyo runs long agent work. Enable the plugin once, and Omnyo keeps the selected machines awake for as long as the app is running.

## What you get

- One switch in the plugin settings that turns idle-sleep prevention on or off.
- A choice between all hosts and a list of specific hosts.
- Automatic reconnection. When a host connects again, Omnyo applies the setting again.

## How it works

The plugin runs on each selected host and holds an idle-sleep assertion while Omnyo is running. When Omnyo stops, the assertion stops with it. The display can still turn off. Closing the lid or choosing Sleep still puts the Mac to sleep.

Use the settings page or the CLI to manage the plugin:

- `omnyo keep-awake status` shows the current state and the host selection.
- `omnyo keep-awake enable` and `omnyo keep-awake disable` change the switch.
- `omnyo keep-awake hosts all` selects every host. `omnyo keep-awake hosts` followed by one or more host ids selects specific hosts.

Add `--json` to any command for machine-readable output.

## Requirements

macOS and Windows hosts are supported. On macOS the plugin runs `caffeinate`; on Windows it holds a system-required execution state from a PowerShell process. Neither keeps the display on. On a Linux host, the plugin does nothing and writes a warning to the log.

## Credits

Maintained and extended by Omnyo, based on the [keep-awake plugin in bb](https://github.com/get-bb/bb/tree/main/plugins/keep-awake). Thank you to Michael Yong and the bb contributors for the original work. The upstream code is [MIT licensed](https://github.com/get-bb/bb/blob/main/LICENSE), copyright (c) 2026 Michael Yong.
