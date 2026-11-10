# CLAUDE.md

Engineering rules for this repository live in **[AGENTS.md](AGENTS.md)** and are authoritative.
Read it before changing anything. This file adds no rules of its own, so the two cannot drift.

Before implementing a task, read in this order:

1. The GitHub Issue (objective, acceptance criteria, implementation map, dependencies).
2. [docs/product/product-overview.md](docs/product/product-overview.md)
3. [docs/architecture/architecture.md](docs/architecture/architecture.md) — folder map §3, rules §14
4. [docs/engineering/tech-stack.md](docs/engineering/tech-stack.md)
5. [docs/engineering/design-patterns.md](docs/engineering/design-patterns.md) — task playbook §13
6. Related ADRs in [docs/architecture/adr/](docs/architecture/adr/)

Run `npm run check` before you report a task as finished. The product CLI `omi` does not exist
yet; do not invoke or emulate it.
