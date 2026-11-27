# Standalone plugins

Each folder here is an Omnyo plugin that builds on its own, outside the pnpm
workspace. A plugin pins its own `@omnyo/plugin-sdk` tarball in `vendor/`, keeps
its own lockfile and runs its own lint, format, typecheck and tests. The root
workspace, lint and format commands skip this folder.

The built-in plugins live in [`plugins/`](../plugins) and build with the rest of
the repository.

## Build and install a plugin

```sh
cd standalone-plugins/<plugin>
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
omnyo plugin build .
omnyo plugin install .
```

After changing a plugin that is already installed from its folder, rebuild it
with `omnyo plugin build .` and run `omnyo plugin reload <id>`. The plugin's own
README describes its settings and any extra steps.
