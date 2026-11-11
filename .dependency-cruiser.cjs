// Import-direction rules from docs/architecture/architecture.md §3.4.
// Paths are relative to the working directory, so the same config also runs
// against the materialized architecture fixtures in the guard tests.
// Exceptions need a name, reason, scope and an ADR (architecture.md §14). No wildcards.

// dependency-cruiser matches `to.path` against the resolved file (node_modules/<pkg>/...), not
// the import specifier, so an anchored `^better-sqlite3` never matched (found in OMI-011).
const IO_NPM = "(^|/)node_modules/(better-sqlite3|@octokit|execa)/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular imports are forbidden (architecture.md §3.4).",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Every import must resolve; an unresolvable import hides the real dependency.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "domain-is-pure",
      severity: "error",
      comment: "Domain imports only domain (architecture.md §3.1, §3.4).",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "domain-no-io-or-libraries",
      severity: "error",
      comment: "Domain has no I/O, Node built-ins or npm libraries (incl. Zod).",
      from: { path: "^src/domain/" },
      to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg"] },
    },
    {
      name: "application-only-ports",
      severity: "error",
      comment: "Application imports domain/application and Zod only; I/O belongs behind ports.",
      from: { path: "^src/application/" },
      to: { pathNot: "^src/(domain|application)/|(^|/)node_modules/zod/" },
    },
    {
      name: "application-no-io",
      severity: "error",
      comment: "Application performs I/O only through ports.",
      from: { path: "^src/application/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "application-no-io-libraries",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: IO_NPM },
    },
    {
      name: "infrastructure-not-to-interfaces-or-bootstrap",
      severity: "error",
      comment:
        "Adapters depend on application ports/contracts, never services, use cases, handlers or wiring.",
      from: { path: "^src/infrastructure/" },
      to: { path: "^src/(interfaces|bootstrap)/|^src/application/(use-cases|services)/" },
    },
    {
      name: "interfaces-not-to-infrastructure",
      severity: "error",
      comment: "Interfaces call use cases; bootstrap injects adapters.",
      from: { path: "^src/interfaces/" },
      to: { path: "^src/(domain|infrastructure|bootstrap)/|^src/application/services/" },
    },
    {
      name: "interfaces-no-sql-github-spawn",
      severity: "error",
      comment: "CLI/IPC handlers never run SQL, HTTP/GitHub calls or spawn processes directly.",
      from: { path: "^src/interfaces/" },
      to: { path: `^(node:)?(child_process|sqlite|http|https|http2)$|${IO_NPM}` },
    },
    {
      name: "only-bootstrap-imports-bootstrap",
      severity: "error",
      comment: "Bootstrap is the composition root; nothing depends on it.",
      from: { path: "^src/", pathNot: "^src/bootstrap/" },
      to: { path: "^src/bootstrap/" },
    },
    {
      name: "src-only-source-modules",
      severity: "error",
      comment: "Production code must not depend on repository config, templates or dev tooling.",
      from: { path: "^src/" },
      to: { dependencyTypes: ["local", "localmodule"], pathNot: "^src/|(^|/)node_modules/" },
    },
    {
      name: "src-not-to-tests-or-tools",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(tests|tools)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Type-only imports count too: a wrong-direction `import type` is still a wrong dependency.
    tsPreCompilationDeps: true,
    // NodeNext: source imports "./x.js" for "./x.ts"; dependency-cruiser maps this itself.
    // The not-to-unresolvable rule plus the valid fixture prove the mapping works.
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
