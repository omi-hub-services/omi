#!/bin/sh
# Managed project-local launcher. Resolve from this file, regardless of caller cwd.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd -- "$root"
node=__OMI_NODE__
if [ ! -x "$node" ]; then
  node=$(command -v node) || {
    printf '%s\n' 'omi: Node.js not found; reinstall omi-squad using a working Node.js, or configure node on PATH.' >&2
    exit 127
  }
fi
# npm worker launchers use /usr/bin/env node; the runtime and its children need this PATH too.
worker_dirs=__OMI_WORKER_DIRS__
PATH="${worker_dirs:+$worker_dirs:}$(dirname -- "$node")${PATH:+:$PATH}"
export PATH
# Internal modes use the same pinned interpreter. They accept exactly these argv and run nothing else.
runtime="$root/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/runtime.js"
case "${1-}" in
  --omi-worker-version)
    if [ "$#" -ne 2 ]; then
      printf '%s\n' 'omi: --omi-worker-version requires claude or codex.' >&2
      exit 2
    fi
    case "$2" in
      claude|codex) exec "$2" --version ;;
      *) printf '%s\n' 'omi: --omi-worker-version requires claude or codex.' >&2; exit 2 ;;
    esac
    ;;
  --omi-node-version)
    [ "$#" -eq 1 ] || { printf '%s\n' 'omi: --omi-node-version takes no arguments.' >&2; exit 2; }
    exec "$node" --version
    ;;
  --omi-runtime)
    if [ "$#" -ne 3 ] || [ "$2" != "$runtime" ] || [ "$3" != "$root" ]; then
      printf '%s\n' 'omi: --omi-runtime only starts this project runtime: --omi-runtime <runtime.js> <project>.' >&2
      exit 2
    fi
    exec "$node" "$runtime" "$root"
    ;;
esac
exec "$node" "$root/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/cli.js" "$@"
