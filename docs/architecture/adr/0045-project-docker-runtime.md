# ADR-0045: Project Docker runtime

Status: Accepted implementation of the approved Docker design · OMI-156 (#320)

## Decision

Projects with a `docker` settings block use one persistent Linux container and named work
volume. Projects without that block retain ADR-0012's WSL path until OMI-158. There is no
runtime enum. This repository's ADR-0036 pin stays WSL-capable until that migration.

`infrastructure/processes/docker-runtime.ts` owns lifecycle argv and probes; bootstrap injects
the lifecycle port into thin CLI handlers. Coordinator tooling consumes this implementation.
`templates/docker/` owns the image and first-start script. No dependency or source module is
added. Architecture §3 records the new template responsibility.

Secrets cross only the environment of a single exec, with names in argv; container creation
has no secret environment. Clone uses an ephemeral Git credential helper, never a token URL.
Login profiles have independent named volumes. Build cache uses a dedicated builder per
project, so pruning cannot remove another project's cache. A finally path prunes and removes
that builder, including its helper container and state volume, after successful or failed builds.
Older worker tags are removed
only after a successful build. Image and CLI versions are exact existing compatibility pins.

Worker lifetime uses the existing owner pipe and owned process groups (ADR-0028); Docker
EOF behavior remains subject to opt-in live acceptance. Task cleanup keeps existing merged
and clean-worktree gates, then removes task scratch, stops recorded owned groups and invokes
ADR-0035 retention. No blanket process-name killing or global Docker prune is permitted.

Docker live acceptance is run by the Coordinator. This decision does not supersede the WSL
ADRs until migration acceptance, and does not grant release or merge approval.

Normal leader exit stops its remaining process group before waiting for output pipes to close;
an orphan can otherwise retain those pipes indefinitely. Output is still drained and validated
before the exit promise resolves. Disposing the owner watch pauses its channel so an open owner
pipe does not keep a completed worker's wrapper alive. New watches explicitly resume the channel.

## Installed runtime relay and watch boundary

The Coordinator's round-2 decision uses transient process environment for the installed runtime.
The CommonJS Windows bridge validates host settings against the packaged generated schema using
Node built-ins, reporting field paths only. Unique profile IDs have explicit parity coverage
with the application contract because that refinement is absent from JSON Schema. The bridge
has one registered ADR-0036 parity entry for that built-in validator: its scope is the schema
subset and unique-ID refinement, required to keep this CommonJS boundary free of npm imports.
The generated application schema remains authoritative; no wildcard exemption is introduced.
The bridge
owns the environment projection; the source config adapter consumes that implementation.
GitHub credentials and indexed profile token slots are forwarded by name only. Metadata contains
empty token placeholders. The container-marked runtime reconstructs settings in memory from the
environment, never a container settings file. Its existing credential policy guards all received
values; worker environment allowlists pass only the chosen profile's token. The native Windows
Coordinator does not inherit the runtime credential environment.

The non-secret image marker `OMI_DOCKER_RUNTIME` selects container behavior. Watch binds all
container interfaces only with that marker; Docker publishes default port 4381 on host
127.0.0.1 only. Outside Docker the server still binds 127.0.0.1. Host/Origin, CSP, read-only
route and bounded-stream guards remain mandatory. This is a scoped amendment of the watch
loopback transport assumption; it does not permit a public host listener.
