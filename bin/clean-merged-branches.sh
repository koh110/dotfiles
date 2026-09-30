#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec node "$root/lib/clean-merged-worktrees.ts" "$@"
