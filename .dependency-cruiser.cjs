// Import-direction rules from docs/architecture/architecture.md §3.4.
// Paths are relative to the working directory, so the same config also runs
// against tests/fixtures/architecture/* in the guard tests.
// Exceptions need a name, reason, scope and an ADR (architecture.md §14). No wildcards.

const IO_CORE =
  "^(node:)?(fs|fs/promises|child_process|net|http|https|http2|dgram|tls|worker_threads|cluster|sqlite)$";
const IO_NPM = "^(better-sqlite3|@octokit/|execa)";

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
      comment:
        "Application depends on domain and its own ports, never on adapters, interfaces or bootstrap.",
      from: { path: "^src/application/" },
      to: { path: "^src/(infrastructure|interfaces|bootstrap)/" },
    },
    {
      name: "application-no-io",
      severity: "error",
      comment: "Application performs I/O only through ports.",
      from: { path: "^src/application/" },
      to: { dependencyTypes: ["core"], path: IO_CORE },
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
      comment: "Adapters implement application ports; they do not call CLI handlers or wiring.",
      from: { path: "^src/infrastructure/" },
      to: { path: "^src/(interfaces|bootstrap)/" },
    },
    {
      name: "interfaces-not-to-infrastructure",
      severity: "error",
      comment: "Interfaces call use cases; bootstrap injects adapters.",
      from: { path: "^src/interfaces/" },
      to: { path: "^src/(infrastructure|bootstrap)/" },
    },
    {
      name: "interfaces-no-sql-github-spawn",
      severity: "error",
      comment: "CLI/IPC handlers never run SQL, GitHub calls or spawn processes directly.",
      from: { path: "^src/interfaces/" },
      to: { path: "^(node:)?(child_process|sqlite)$|^(better-sqlite3|@octokit/|execa)" },
    },
    {
      name: "only-bootstrap-imports-bootstrap",
      severity: "error",
      comment: "Bootstrap is the composition root; nothing depends on it.",
      from: { path: "^src/", pathNot: "^src/bootstrap/" },
      to: { path: "^src/bootstrap/" },
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
    exclude: { path: "(^|/)(dist|coverage|\\.tmp)/" },
    // NodeNext: source imports "./x.js" for "./x.ts"; dependency-cruiser maps this itself.
    // The not-to-unresolvable rule plus the valid fixture prove the mapping works.
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
