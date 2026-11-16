# Caspion Flatpak

Flatpak packaging for Caspion. This directory is the Flathub submission payload: its
contents become the root of the `flathub/io.github.brafdlog.Caspion` repository verbatim.

## Build

```bash
bash flatpak/build.sh
```

Prerequisites:

- `flatpak` (the script installs `org.flatpak.Builder` into the user installation, so no root
  and no distro `flatpak-builder` are needed)
- internet access while building: `flatpak-builder` downloads the runtime, the Electron2 BaseApp,
  the node22 SDK extension, the pinned git commit, the npm archives and the Electron binary/headers
- ~2 GB of disk for the runtime, BaseApp and SDK extension; the first run is slow because
  `electron-builder` unpacks Electron and `keytar` is compiled from source

The script builds the app from source inside the sandbox (`electron-builder --dir`, no prebuilt
binary), installs `io.github.brafdlog.Caspion` for the current user and writes
`flatpak/io.github.brafdlog.Caspion.flatpak`.

## Run / CLI

```bash
flatpak run io.github.brafdlog.Caspion
flatpak run io.github.brafdlog.Caspion --scrape
```

- Configuration and logs live in `~/.var/app/io.github.brafdlog.Caspion` (for example
  `config/caspion/config.encrypt`, and the Chromium download used by the scrapers).
- Accounts and secrets are stored in the desktop keyring through `org.freedesktop.secrets`
  (keytar/libsecret), not inside the sandbox.
- `--filesystem=xdg-documents` is granted because scheduled CSV/JSON exports write to
  `~/Documents` without a file chooser.
- Updates come from `flatpak update`; the in-app updater is disabled because `/app` is read-only.
- `--scrape` accepts the same cron usage as the non-Flatpak build.

## Regenerate dependency sources

Only needed when `yarn.lock` changes:

```bash
uvx --from "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node" \
  flatpak-node-generator yarn yarn.lock --electron-node-headers -o flatpak/generated-sources.json
```

Then verify that the node-gyp headers directory in `flatpak/generated-sources.json` matches the
`electron` version in `yarn.lock`:

```bash
jq -r '.[] | select(.url? // "" | test("node-gyp")) | .url + " -> " + (.dest // "")' \
  flatpak/generated-sources.json
```

If the Electron version changed, update `npm_config_target` and `npm_config_nodedir` in the
manifest so they point at the new version.

## Submitting to Flathub

1. Fork `flathub/flathub`.
2. `git checkout --track origin/new-pr`.
3. Copy everything in `flatpak/` to the repository root, commit and open the pull request.
4. In the PR description, justify every permission:
   - `--talk-name=org.freedesktop.secrets`: account credentials and the encrypted config are
     stored in the desktop keyring via keytar/libsecret.
   - `--filesystem=xdg-documents`: scheduled CSV/JSON exports write into `~/Documents`.

## Maintenance after the Flatpak changes are merged and released

- Delete `patches/0001-flatpak-runtime-support.patch` and its `- type: patch` entry in the manifest.
- Bump the `type: git` `commit:` to the release commit.
- Update `<release version="…" date="…"/>` in the metainfo file.
