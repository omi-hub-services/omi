# ADR-0011 — Bootstrap toolchain and architecture guard baseline

- Status: Accepted (bootstrap, OMI-001)
- Date: 2026-11-10
- Context documents: `docs/engineering/tech-stack.md` §2–§4, §10; `docs/architecture/architecture.md` §3, §14
- ADR-0001…0010 are the initial decisions listed in architecture.md §15; they are recorded
  there and not duplicated as files yet.

## Decision

### Pinned versions

| Tool               | Version | Notes                                                                    |
| ------------------ | ------- | ------------------------------------------------------------------------ |
| Node.js            | 24.22.2 | `.nvmrc`; Krypton LTS, released 2026-10-27; `engines: >=24.22.2 <25`      |
| npm                | 11.19.1 | Bundled with Node 24.22.2                                                |
| TypeScript         | 6.0.3   | See deviation below                                                      |
| ESLint             | 10.13.0 | with `@eslint/js` 10.0.1                                                 |
| typescript-eslint  | 8.72.1  | `strictTypeChecked`                                                      |
| Prettier           | 3.9.10  | config in `package.json` (no extra root file)                            |
| Vitest             | 4.1.12  | Node environment                                                         |
| dependency-cruiser | 18.7.0  | engines `^22 \|\| ^24 \|\| >=26`                                          |
| @types/node        | 24.19.2 | matches the Node 24 line                                                 |
| yaml               | 2.9.1   | dev-only for now: reads `docs/planning/github-backlog.yaml` in `tools/`  |

All versions were at least 14 days old on 2026-11-10 (newer patches existed for eslint,
typescript-eslint, vitest, dependency-cruiser; they were not taken yet). `save-exact` and
`engine-strict` are set in `.npmrc`. Only bootstrap dev dependencies are installed; runtime
libraries (Commander, Zod, better-sqlite3, Pino) are added by the Issues that need them.

### Deviations from tech-stack.md and why

- **TypeScript 6.0.3, not the latest 7.0.2.** `typescript-eslint@8.72.1` declares the peer
  range `typescript >=4.8.4 <6.1.0`; TS 7 is outside it. Upgrade together with
  typescript-eslint when its peer range includes 7.x.
- **`build` is not part of `npm run check` yet.** `tsc -p tsconfig.build.json` fails with
  TS18003 while `src/` has no module, and OMI-001 must not add placeholder code to make it
  pass. `typecheck` already compiles tools/tests/config with the same strict options. The first
  Issue that adds a `src/` module (OMI-007) puts `build` into `check` and CI.
- **Tools run as TypeScript through Node's built-in type stripping** (`node tools/x.ts`) instead
  of adding `tsx`/`ts-node`. `tsconfig.json` sets `erasableSyntaxOnly` and
  `allowImportingTsExtensions` with `noEmit` so this stays valid. Node 24.22 still prints an
  `ExperimentalWarning` for type stripping; it is harmless.
- **Prettier does not reformat `docs/**/*.md`.** The five handed-over design documents are kept
  byte-for-byte; formatting them would rewrite every table.
- **Root files.** Prettier config lives in `package.json`, so no `.prettierrc`/
  `.prettierignore` is added outside the architecture.md root allowlist. No `LICENSE` is added:
  choosing a license is a PO decision.

### Architecture guard baseline

- `.dependency-cruiser.cjs` enforces architecture.md §3.4: no cycles, no unresolvable imports,
  domain imports only domain (no built-ins/npm), application never imports infrastructure/
  interfaces/bootstrap or I/O built-ins, infrastructure never imports interfaces/bootstrap,
  interfaces never import infrastructure or `child_process`/SQLite/GitHub clients, only bootstrap
  imports bootstrap, `src/` never imports `tests/` or `tools/`. `tsPreCompilationDeps: true`
  makes type-only imports count.
- `tools/check-structure.ts` enforces the root file/dir allowlist, the `src/` module directory
  map from architecture.md §3.1–3.3, bootstrap entrypoints, kebab-case source names, vague
  names, test placement under `tests/{unit,integration,contract,e2e,live}` and forbidden
  committed files (`.env*`, logs, SQLite, keys, credential JSON, `.omi-squad/local/`).
  `tests/fixtures/` is exempt only from the test-placement rule, never from secret checks.
- Fixtures in `tests/fixtures/architecture/{valid,invalid-imports,invalid-structure}` and
  `tests/integration/tools/architecture-guard.test.ts` prove each rule both accepts and rejects.
- Not yet covered (OMI-043): generated schema drift, naming of types/functions, required checks.

### Known advisory

`npm audit` (2026-11-10) reports a moderate ReDoS advisory (GHSA-g3hv-75wg-m249) in
`minimatch` pulled in by ESLint 10 and typescript-eslint. It affects only the dev lint
toolchain on repository-controlled globs; no fixed release exists in the pinned or latest
typescript-eslint. Production dependencies: 0 vulnerabilities. Re-check when bumping.

## Evidence

Environment of the bootstrap run: Windows 11 (no WSL Ubuntu distribution installed; WSL has only
`docker-desktop`), Git 2.55.0.windows.5, gh 2.100.0, portable Node 24.22.2 verified against the
official `SHASUMS256.txt`. CI runs the same `npm run check` on `ubuntu-latest` with the `.nvmrc`
version. The WSL2 target environment itself is verified by OMI-005.
