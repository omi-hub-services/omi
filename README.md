# omi

Development repository of **omi-squad** — a framework installed separately into each project
that turns the main Claude Code session into a **Coordinator** for a squad of Claude Code/Codex
agents. The Coordinator runs workflows over GitHub Issues and a GitHub Project: clarify the
request, pick a workflow, assign roles, choose an available tool/model/profile, verify quality,
and drive work to a PR merged into `develop`; releases to `main` and production deploys need
separate Product Owner approval.

## Status: bootstrap

Only the repository scaffold exists: folder map, toolchain, engineering rules and architecture
guards. **There is no runtime, agent adapter, profile switching or product CLI yet.** The
`omi` / `omi-squad` command described in the docs is planned (OMI-011 and later) and does not
exist. Work is tracked in the [GitHub Project](https://github.com/orgs/omi-hub-services/projects/1) and the
[backlog manifest](docs/planning/github-backlog.yaml).

## Documents

| Topic                       | Document                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| Product scope and decisions | [docs/product/product-overview.md](docs/product/product-overview.md)       |
| Architecture and folder map | [docs/architecture/architecture.md](docs/architecture/architecture.md)     |
| Architecture decisions      | [docs/architecture/adr/](docs/architecture/adr/)                           |
| Tech stack and versions     | [docs/engineering/tech-stack.md](docs/engineering/tech-stack.md)           |
| Design patterns, playbook   | [docs/engineering/design-patterns.md](docs/engineering/design-patterns.md) |
| Project plan, Issue tree    | [docs/planning/project-plan.md](docs/planning/project-plan.md)             |
| GitHub Project and mapping  | [docs/planning/github-project.md](docs/planning/github-project.md)         |
| Engineering rules           | [AGENTS.md](AGENTS.md) (authoritative), [CLAUDE.md](CLAUDE.md) (pointer)   |

## Development

Requirements: Node.js **24.22.2** (see `.nvmrc`; `engine-strict` rejects other versions), npm
11, Git. The target environment for the framework runtime is WSL2/Ubuntu.

```sh
nvm use          # or install the version in .nvmrc
npm ci
npm run check    # everything below except build
```

Development commands that exist today:

| Command                      | What it does                                                              |
| ---------------------------- | ------------------------------------------------------------------------- |
| `npm run typecheck`          | `tsc` strict type check of src, tests, tools and config                   |
| `npm run lint`               | ESLint with typescript-eslint `strictTypeChecked`                         |
| `npm run format:check`       | Prettier check (`npm run format` to write)                                |
| `npm run check:architecture` | dependency-cruiser layer/cycle rules + `tools/check-structure.ts`         |
| `npm run check:backlog`      | validates `docs/planning/github-backlog.yaml` against the project plan    |
| `npm run test:unit`          | Vitest, `tests/unit/`                                                     |
| `npm run test:integration`   | Vitest, `tests/integration/` (runs the guards on fixtures)                |
| `npm run build`              | `tsc` emit to `dist/`; fails until `src/` has its first module (ADR-0011) |

`test:contract`, `test:e2e`, `test:live`, `schemas:*` and `pack:check` from tech-stack.md are
added by the Issues that introduce those tests and artifacts.

## Branches

`main` is the release branch, `develop` the integration branch. Task branches start from
`develop` and open a PR into `develop` that links a real Issue. Release PRs `develop` → `main`
require PO approval. Details in [AGENTS.md](AGENTS.md#8-branches-prs-and-done).
