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
- `.live-npm/config.yaml`
- `.live-npm/pnpmfile-snippet.cjs` when a root pnpmfile already exists

Add `.live-npm/` to the consuming project's `.gitignore` unless you intentionally want to share local integration files.

pnpm still needs an entry point. If the project has no `.pnpmfile.cjs` or `.pnpmfile.mjs`, `integrate` creates a tiny root `.pnpmfile.cjs` shim that loads `.live-npm/pnpmfile.cjs`. If a root pnpmfile already exists, `integrate` does not edit it; merge the generated `.live-npm/pnpmfile-snippet.cjs` manually. pnpm supports only one `hooks.importPackage`, so projects that already customize `importPackage` need to wrap or delegate that hook explicitly.

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

## Usage

Start the local server:

```powershell
live-npm start
```

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

## Legacy Target Commands

The old direct-copy workflow is still available for debugging:

```powershell
live-npm once ./node_modules
live-npm watch ./node_modules
```

These commands read `.live-npm/config.yaml` and publish each selected package into a target `node_modules`-style root.

## Notes

`live-npm` keeps package files live after install, including file additions, modifications, deletions, and rewritten `package.json` content.

If a source package changes its dependency graph, run `pnpm install` again. live-npm cannot make pnpm install new dependencies after the install has already settled.

For best performance, keep `package.json#files` focused on build outputs such as `lib` or `dist`. When `files` is declared, the watcher can focus on those publish entries plus package metadata. When `files` is omitted, `live-npm` falls back to watching the package root because npm may publish any non-ignored file.
