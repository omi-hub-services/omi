---
id: architecture-boundaries
version: 1
mandatory: false
---

# Architecture boundaries

- Decide the layer and owning module of every new file before writing it, and follow the
  repository's folder map and dependency direction.
- Reuse the module that already owns a behaviour instead of copying logic.
- Validate every external input at the boundary.
- Structural changes, new dependencies and guard exceptions need a decision record first.
