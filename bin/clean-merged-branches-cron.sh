#!/bin/sh
set -eu

usage() {
  printf '%s\n' 'Usage: clean-merged-worktrees-cron.sh'
  printf '%s\n' 'Runs the merged-worktree cleanup in apply mode with cron-formatted output.'
}

if [ "$#" -gt 0 ]; then
  if [ "$#" -eq 1 ] && { [ "$1" = '--help' ] || [ "$1" = '-h' ]; }; then
    usage
    exit 0
  fi
  printf '%s\n' 'clean-merged-worktrees-cron.sh: no arguments are accepted' >&2
  usage >&2
  exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec "$root/bin/clean-merged-worktrees.sh" --apply --cron
