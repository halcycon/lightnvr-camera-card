# Development and Tailor layout

The repository adopts [Tailor 0.6.0](https://github.com/wimpysworld/tailor/releases/tag/v0.6.0). `.tailor.yml` declares GPL-3.0, TypeScript support, community files and repository/security settings. The original scaffold had been applied, but project overrides bypassed its native quality workflow. That manual-adoption gap was completed with a fresh `tailor measure`, `tailor baste` and `tailor alter` on 2026-11-11.

## Commands

Use Node 22 (the regular CI baseline is 22.22.2) and npm 11.8.0. Install dependencies with the locked package manager:

```sh
npx --yes --package npm@11.8.0 npm ci
```

With Nix, enter `nix develop` for Just, Actionlint, Node and the native quality tools. The committed flake lock pins the inputs; the project's overlay selects Node 22 while Tailor keeps its generic JavaScript fragment. The Nix CI job evaluates the flake and runs the actual lint/test/build commands inside that shell.

Without Nix, install the pinned Just and Actionlint binaries into the ignored project directory, then add that directory to this shell's PATH:

```sh
npm run setup:tools
export PATH="$PWD/.execution/quality-tools/bin:$PATH"
```

The bootstrap verifies fixed SHA-256 checksums from the official Just 1.59.0 and Actionlint 1.7.12 releases. It changes no system install or shell profile. Oxlint 1.93.0 and Prettier 3.9.10 are npm lockfile dependencies. Once dependencies are installed, the Just entry point places these project tools on PATH ahead of global versions.

```sh
just lint           # Actionlint, Oxlint, Prettier check, then TypeScript
just lint correct   # Format eligible source, then run the same checks
just test           # Unit and contract tests
just build          # Build the standalone card and check release contents
```

`npm run lint` and `npm run format` enter the same Tailor workflow. `npm run build`, `npm run test:unit` and `npm run typecheck` remain the underlying project commands used by the hooks. Real NVR/proxy/HA tests are explicit, isolated operations; follow [the acceptance instructions](../tests/e2e/README.md).

## File ownership

| Path | Purpose |
| --- | --- |
| `.tailor.yml` | Reviewed Tailor settings and alteration policy |
| `justfile` | Imports Tailor's loader and supplies the local tool PATH; no quality recipe overrides |
| `just/loader.just`, `just/tailor.just` | Tailor-managed command composition and native quality workflow |
| `just/javascript.just` | Tailor's intentionally empty compatibility import; JavaScript quality lives in the shared recipe |
| `just/project/build.sh` | Project build and release-shape check |
| `just/project/test.sh` | Project unit tests |
| `just/project/lint.sh` | TypeScript check after native lint/format checks |
| `.oxlintrc.json`, `.prettierrc.json`, `.prettierignore` | Adopted native policy starters with documented project settings |
| `flake.nix`, `flake.lock`, `.envrc`, `nix/` | Locked optional development shell and Tailor fragments |
| `.github/workflows/card-ci.yml` | Runs these same commands, plus HACS metadata validation and a Nix-shell job |

The formatter preserves embedded Lit HTML/CSS whitespace. Oxlint uses Tailor's correctness baseline with TypeScript, Unicorn and Oxc plugins, browser/Node environments and an explicit no-`any` rule. TypeScript remains strict. Four narrow `no-useless-spread` exceptions retain the existing observer/cleanup snapshots; no lifecycle code was changed to satisfy a style suggestion. ESLint and its obsolete dependency override were removed during this explicit native-tool migration.

## Intentional Tailor exceptions

Tailor's post-adoption `measure` reports two deliberate mode differences: the PR template uses `first-fit` so it is actually present, while Dependabot uses `never` because its project-owned npm group must survive alongside Tailor's GitHub Actions/Nix groups. Tailor 0.6 replaces that complete file and does not generate npm updates. Neither difference is a missing file or unresolved JavaScript adoption warning.

A subsequent `baste` proposes no local file changes. It can still reapply the Dependency Graph enable request and report GitHub's non-provider secret-pattern setting; those remote settings are verified by GitHub/Tailor, not inferred from a local template. GitHub Code Quality is unavailable for this repository and remains skipped. CodeQL, vulnerability alerts and provider-pattern secret scanning remain enabled. Tailor requests non-provider patterns too, but GitHub continues to report that optional setting disabled; no successful enablement is claimed for it.

Before future template updates, run `tailor baste` and inspect the complete preview. Use `tailor alter` to apply reviewed changes; keep project logic in the hooks. Tailor's first-fit rules preserve the root project configuration and existing `.gitignore`; the additional Nix/direnv output rules preserve the original private-data exclusions. Do not publish `.execution/`, generated credentials or browser state.
