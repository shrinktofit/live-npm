# live-npm

`live-npm` is a pnpm 11 development tool for consuming local packages through `live:` dependency specs.

It is meant for the awkward middle ground between `link:` and `file:`:

- `link:` is live, but many tools resolve the real source path and miss the consuming project's installed dependency graph.
- `file:` installs like a package, but it is a snapshot and normally needs another `pnpm install` after changes.

`live-npm` lets pnpm install a package-shaped snapshot, then keeps the installed package directory fresh after installation.

## Install

This repository is a pnpm monorepo. The CLI package is `@live-npm/cli`.

```powershell
pnpm install
pnpm build
pnpm link -g --filter @live-npm/cli
```

During development you can run the CLI from the workspace:

```powershell
pnpm build
pnpm cli -- --help
```

## Consumer Setup

The consuming project must use pnpm 11 or newer.

```powershell
live-npm integrate
```

`integrate` writes live-npm-owned files under `.live-npm/`:

- `.live-npm/pnpm-hooks.cjs`
- `.live-npm/pnpmfile.cjs`
- `.live-npm/version.json`
- `.live-npm/config.yaml`
- `.live-npm/state.json` after pnpm imports live packages
- `.live-npm/server.json` while a project server is running

If `.live-npm/config.yaml` already exists, `integrate` keeps it unchanged.
`integrate` updates `.live-npm/version.json` every time so `live-npm start` can detect old project integration files and prompt you to refresh them. The current integration mode is recorded as `cjs-marked-block`.

Add `.live-npm/` to the consuming project's `.gitignore` unless you intentionally want to share local integration files.

pnpm still needs an entry point. `integrate` creates or updates the root `.pnpmfile.cjs` with a marked live-npm block that loads `.live-npm/pnpmfile.cjs` and merges live-npm hooks into the existing pnpmfile export. Re-running `integrate` updates that marked block instead of duplicating it. Root `.pnpmfile.mjs` is not supported yet.

## Config

Edit `.live-npm/config.yaml` in the consuming project:

```yaml
debounceMs: 200

packages:
  - source: ../my-workspace/packages/runtime

workspaces:
  - path: ../my-workspace
    includes:
      - '@scope/runtime'
```

Config paths are resolved relative to `.live-npm/config.yaml`. There is no `target` field in hook mode. pnpm tells the live-npm server which project is installing the package, and the server publishes snapshots into that project's `.live-npm/store/` and the actual installed package directory.

`live-npm` uses `npm-packlist`, so copied files follow npm publish / pack rules. If the source package does not declare `package.json#files`, npm's default packlist behavior is used.

Workspace mode currently supports pnpm only. `live-npm` infers the package manager from `package.json#packageManager`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`; npm, yarn, and bun workspaces are rejected for now. It expands the local workspace dependency closure through `dependencies`, `optionalDependencies`, and `peerDependencies`; `devDependencies` are not included.

An empty config is valid immediately after `integrate`, but it cannot resolve any `live:` package yet. If `pnpm install` reports that `.live-npm/config.yaml` has no source packages or workspaces configured, add either a `packages` entry or a `workspaces` entry whose `includes` contains the `live:` package name.

## Usage

Start the local server:

```powershell
live-npm start
```

`start` restores `.live-npm/state.json` from the current directory by default, so restarting the server reconnects previously imported package directories without another install. It also writes `.live-npm/server.json` with the current local endpoint and a token; pnpm hooks read that file on every request, so projects do not share a fixed port.

By default, `start` tries the previous project port recorded in `.live-npm/server.json`. If that port is unavailable, it selects a new available port, rewrites `server.json`, and keeps going. Reinstalling is not required just because the port changed.

When starting from a different directory, pass one or more projects explicitly:

```powershell
live-npm start --project path/to/consumer-project
```

If a project has `.live-npm/config.yaml` but no `.live-npm/state.json`, `start` prints a warning. Run `pnpm install` once while the server is running so pnpm can register live package import targets.

Inspect the running project server from another terminal:

```powershell
live-npm status
```

`status` reads `.live-npm/server.json`, connects to the running local server, and prints active packages, watch groups, watch roots, watched directory counts, and last publish information. Use `live-npm status --json` for raw JSON.

Use `live:` specs in the consuming project:

```json
{
  "dependencies": {
    "@scope/runtime": "live:@scope/runtime"
  }
}
```

Then install normally:

```powershell
pnpm install
```

During install, pnpm asks live-npm to resolve and fetch `live:` packages. After import, live-npm records the actual installed package directory and keeps it updated while the server is running.

## Troubleshooting

If `live-npm start` warns that `.live-npm/version.json` is missing or outdated, run:

```powershell
live-npm integrate
```

Then restart `live-npm start`. This refreshes generated project files such as `.live-npm/pnpm-hooks.cjs`, `.live-npm/pnpmfile.cjs`, and the marked live-npm block in the root `.pnpmfile.cjs`.

If `pnpm install` says `live-npm cannot resolve live:<name>`, the server is running but the package is not declared in `.live-npm/config.yaml`. Add the package source directly under `packages`, or include it in a configured pnpm workspace.

If `pnpm install` says it cannot read `.live-npm/server.json`, start the project server before installing:

```powershell
live-npm start
```

## Notes

`live-npm` keeps package files live after install, including file additions, modifications, deletions, and rewritten `package.json` content.

If a source package changes its dependency graph, run `pnpm install` again. live-npm cannot make pnpm install new dependencies after the install has already settled.

For best performance, keep `package.json#files` focused on build outputs such as `lib` or `dist`. When `files` is declared, the watcher can focus on those publish entries plus package metadata. When `files` is omitted, `live-npm` falls back to watching the package root because npm may publish any non-ignored file.

Direct `packages` entries use one watcher per source package. Packages selected from the same `workspaces` entry share one workspace watcher backend, then route events back to the affected package runtimes.
