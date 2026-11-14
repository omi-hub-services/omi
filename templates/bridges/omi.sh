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
# Run another script (the session runtime, the doctor probe) with the same pinned interpreter.
if [ "${1-}" = --omi-node-exec ]; then
  shift
  exec "$node" "$@"
fi
exec "$node" "$root/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/cli.js" "$@"
