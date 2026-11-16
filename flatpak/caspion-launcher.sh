#!/bin/sh
# Flatpak entry point. Per-app TMPDIR, then Electron via zypak so Chromium's
# sandbox is redirected to the Flatpak sandbox.
set -eu

export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

exec zypak-wrapper /app/caspion/caspion --ozone-platform-hint=auto "$@"
