# live-npm

`live-npm` is a small development tool for live-publishing local npm packages into another folder.

It is meant for the awkward middle ground between `link:` and `file:`:

- `link:` is great for live editing, but tools may resolve the real source path and miss the consuming project's dependency graph.
- `file:` behaves closer to a real installed package, but it is a snapshot and normally needs `pnpm install` again after changes.

`live-npm` keeps the `file:` style target fresh by copying the files that npm would publish.

## Install

This repository is a pnpm monorepo. The CLI package is `@live-npm/cli`.

```powershell
pnpm install
pnpm build
```

During development you can run the CLI from the workspace:

```powershell
pnpm build
pnpm cli -- --help
```

## Config

Create a YAML config:

```yaml
debounceMs: 200
packages:
  - source: ../my-workspace/packages/runtime
    target: ./.live-npm-store/@scope/runtime
```

Each package entry has:

- `source`: local npm package root. It must contain `package.json`.
- `target`: folder that should receive the live-published package.

`live-npm` uses `npm-packlist`, so the copied files follow npm publish / pack rules instead of a hand-written glob clone. If the source package does not declare `package.json#files`, npm's default packlist behavior is used.

You can also publish a dependency closure from a pnpm workspace:

```yaml
workspaces:
  - path: ../my-workspace
    includes:
      - '@scope/runtime'
    target: ./.live-npm-store
```

Workspace mode currently supports pnpm only. `live-npm` infers the package manager from `package.json#packageManager`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`; npm, yarn, and bun workspaces are rejected for now. For each included package, `live-npm` lists the workspace packages through pnpm, then expands the local workspace dependency closure through `dependencies`, `optionalDependencies`, and `peerDependencies`. `devDependencies` are not included. Every selected workspace package is published into the target `node_modules` folder, and `workspace:` / `catalog:` dependency specs in the copied `package.json` files are rewritten to regular versions. A workspace package only needs `package.json#version` when another published package references it through a `workspace:` dependency spec that must be rewritten. The workspace code is organized around a driver interface, so npm and yarn support can be added as separate drivers later.

## Usage

Publish once:

```powershell
live-npm --config live-npm.yaml --once
```

Watch and publish on changes:

```powershell
live-npm --config live-npm.yaml
```

Preview without writing:

```powershell
live-npm --config live-npm.yaml --once --dry-run
```

## Notes

`live-npm` only copies package files. It does not install new dependencies.

If a source package changes its `dependencies`, run your package manager in the consuming project again.

For best performance, keep `package.json#files` focused on build outputs such as `lib` or `dist`. When `files` is declared, the watcher can focus on those publish entries plus package metadata. When `files` is omitted, `live-npm` falls back to watching the package root because npm may publish any non-ignored file.
