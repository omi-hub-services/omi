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
# Internal modes use the same pinned interpreter. They accept exactly these argv and run nothing else.
runtime="$root/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/runtime.js"
case "${1-}" in
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
