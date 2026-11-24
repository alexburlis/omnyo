# Omnyo

Omnyo is a local-first workspace for coding agents. The source preview includes the coordinator, browser app, CLI, host daemon, and in-tree plugins. It uses no companion plugin repository and disables built-in diagnostic collection.

## Start from source

Install Git, Node.js 22.23.5 or newer in the Node 22 line, and pnpm 10.34.5. From the repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm start
```

Open the local URL printed by the launcher. Use `pnpm start --dryrun` to build the required artifacts and inspect the resolved startup configuration without starting services.

The preview omits hosted marketing and operator deployment material, prebuilt releases, private companion plugins, and recorded diagnostics. Connecting a coding provider still requires your own supported provider installation and credentials.

See [configuration](docs/configuration.md) and the [CLI guide](docs/cli-guide-and-skill.md) for local settings and commands. The [MIT license](LICENSE), [notices](NOTICE), and [upstream credits](docs/upstream-credits.md) describe the source attribution.
