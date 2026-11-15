# Docker worker runtime

Fill local settings with a `docker` block to select Docker. Without that block the
existing WSL binding remains available until the separate WSL removal migration.
Run the installed CLI from the host project directory:

```text
node .omi/bin/omi.cjs docker build
node .omi/bin/omi.cjs docker up
node .omi/bin/omi.cjs profile login <codex-profile-id>
node .omi/bin/omi.cjs doctor --project . --json
```

Build uses the packaged template, existing compatibility pins, a dedicated project builder,
and prunes and removes that builder after successful or failed builds, including its helper
container and state volume. Older worker tags and dangling labelled worker
images are removed without forcing removal of images still used by a container. An in-use
old image causes a fixed failure rather than forcibly breaking another project.

The named work volume holds the checkout, worktrees, logs and scratch under `/work`.
Login profiles use separate volumes at `/profiles/<id>`. `docker down` removes the container
and retains volumes. `docker down --volumes` also removes project data and the configured
login volumes; shared login volumes in use by another project cannot be removed by Docker.

Secrets are read by the host settings loader and forwarded per exec as environment names.
Never add token values to shell commands, container creation flags, prompts or reports.
The repository Coordinator's dispatch, log, status and watch commands use the same transport.
Its host checkout and ADR-0036 pin remain WSL-capable until the repository migration.

The Windows launcher validates host settings with the packaged schema. Session startup forwards
GitHub access and configured profile token slots through the runtime exec environment. Metadata
contains token placeholders; the runtime reconstructs settings in memory and never reads a
settings file inside the container. Native workers receive only their selected profile token.
Git and GitHub service processes do not inherit profile relay slots. Neither prompts nor argv
contain those values. Native Windows Coordinator startup receives its usual host environment.

The image marks its Docker runtime explicitly. The installed watch server uses the container
interface only under that marker. Container startup publishes default watch port 4381 on
host loopback only, so the printed localhost URL is reachable from Windows. Host/Origin and
read-only HTTP checks remain active. Other watch ports need a matching Docker port mapping.

Task cleanup retains the merged/clean-worktree gates, stops recorded groups only when kernel
identity matches, checks the worktree again, removes the worktree with ignored dependencies,
removes task scratch and compresses completed logs through the shared retention policy.
Unknown ownership refuses cleanup. Normal supervision kills descendants before completion.
Processes that deliberately create a separate session remain outside ADR-0028's group model.

Normal completion kills remaining members of the worker's owned group when its leader exits,
then drains output. The wrapper pauses its owner channel before returning, so the Coordinator
does not have to close its pipe for a completed dispatch to return.

## Coordinator live acceptance

Workers cannot reach Docker. On the fixed implementation revision run `npm run build` first.
Use a dedicated, disposable Docker context, and set `OMI_LIVE_DOCKER=1`,
`OMI_LIVE_DOCKER_CONTEXT` to its name (not `default`), and optionally
`OMI_LIVE_DOCKER_IMAGE` to an `omi-worker:<tag>` image. Use the same image for both runs:

```text
node node_modules/vitest/vitest.mjs run tests/live/docker-runtime/image-build.test.ts
node node_modules/vitest/vitest.mjs run tests/live/docker-runtime/dispatch.test.ts tests/live/docker-runtime/owner-exit.test.ts tests/live/docker-runtime/cleanup-five.test.ts
```

The first test builds and runs `npm ci` with the framework's native SQLite dependency.
The other tests use disposable project containers and volumes, a fake worker executable,
and fake credentials; no model quota is spent. They assert secret absence from inspect/logs,
abrupt owner exit via the Docker stdin pipe, and stable worktrees/processes/images/scratch
after five dispatches and cleanups. Temporary host fixtures live under `.tmp/docker-live`.
Cleanup removes only fixture containers and volumes. The built worker image remains available
for the next suite; build tests deliberately remove older worker images in the isolated context.

Default test runs skip these four cases. A skip is not live acceptance evidence. OMI-157
owns acceptance with real profiles on omi-minibox before WSL removal.
