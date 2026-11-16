#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLATPAK_DIR="${REPO_ROOT}/flatpak"
APP_ID="io.github.brafdlog.Caspion"

cd "${REPO_ROOT}"

# Tooling in the user installation: no root, no distro flatpak-builder required.
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.flatpak.Builder
flatpak install --user -y flathub \
  org.freedesktop.Platform//26.08 \
  org.freedesktop.Sdk//26.08 \
  org.freedesktop.Sdk.Extension.node22//26.08 \
  org.electronjs.Electron2.BaseApp//26.08

# flatpak-builder looks up the runtime, SDK and BaseApp by forwarding `flatpak info` to the
# host with a cleared environment plus this process's XDG_DATA_HOME. Inside the Builder
# sandbox that variable points at the app's own data directory, which holds no user
# installation, so the lookup fails. Exporting the real user installation makes both the
# forwarded lookups and the sandboxed installs use it.
flatpak run --user --command=sh --share=network --filesystem=home org.flatpak.Builder -c "
  export XDG_DATA_HOME=\$HOME/.local/share
  exec flatpak-builder \
    --user --install --force-clean \
    --state-dir=${FLATPAK_DIR}/.flatpak-builder \
    --repo=${FLATPAK_DIR}/repo \
    ${FLATPAK_DIR}/build-dir \
    ${FLATPAK_DIR}/${APP_ID}.yml
"

flatpak build-bundle "${FLATPAK_DIR}/repo" "${FLATPAK_DIR}/${APP_ID}.flatpak" "${APP_ID}"
