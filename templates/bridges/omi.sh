#!/bin/sh
# Managed project-local launcher. Resolve from this file, regardless of caller cwd.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd -- "$root"
exec node "$root/.omi-squad/tool/node_modules/omi-squad/dist/bootstrap/cli.js" "$@"
