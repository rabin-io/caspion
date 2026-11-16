# Package Caspion for Flathub

Goal: a Flathub-submittable Flatpak (`io.github.brafdlog.Caspion`) that builds **entirely from source, offline** inside `flatpak-builder`, plus the two app-code changes the sandbox requires (Chromium sandbox opt-out for the puppeteer browser, updater disabled because `/app` is read-only).

Decisions already taken (do not re-open):
- Build path = the Flathub Electron pattern: `org.freedesktop.Platform//26.08` + `base: org.electronjs.Electron2.BaseApp//26.08` + `org.freedesktop.Sdk.Extension.node22`, yarn v1 `--offline` against a `flatpak-node-generator`-produced `generated-sources.json`, then `electron-builder --dir` inside the sandbox, run through `zypak-wrapper`. No prebuilt app dump, no `type: dir` source (Flathub linter error `module-* -source-dir-not-allowed`).
- App source = upstream commit `0f634666a8ee26cab53cb72065dcb7ac85f5db05` (current `origin/master`) plus a local patch carrying the Flatpak runtime changes, because those changes are not released yet. `type: patch` + `path:` and `type: file` + `path:` are allowed by Flathub (Obsidian, GitHub Desktop, Logseq all ship them); git needs `commit:` (a bare `branch:` that is not a commit hash is an error, `tag:` without `commit:` is an error for new submissions).
- keytar (native, libsecret, `install: prebuild-install || npm run build`) is compiled inside the build by node-gyp against **Electron** headers, because `flatpak-node-generator` does not vendor `prebuild-install` prebuilds. Required env triple: `npm_config_target`, `npm_config_runtime=electron`, `npm_config_nodedir=<prefetched electron headers>`, plus `ln -s $XDG_CACHE_HOME/node-gyp $HOME/.electron-gyp` for `@electron/rebuild` (electron-builder).
- `libsecret` 0.21.7 is built as a separate module in-front of the app module: the build sandbox has the SDK, not the BaseApp, so keytar's `pkg-config libsecret-1` cannot resolve otherwise; at runtime the BaseApp ships the same soname.
- Electron binary/zip and node-gyp headers come from the generated sources (XDG layout): `flatpak-node/cache/electron/electron-v39.8.5-linux-<arch>.zip` and `flatpak-node/cache/node-gyp/39.8.5/`.

## Approach

### Step 0 — Commit the plan as the first execution commit

0.1 Write this plan verbatim to `docs/flatpak-packaging-plan.md` (source of truth: `local://caspion-flathub-packaging-plan.md`).

0.2 Commit only that file, as the first commit of the execution, with the eval `commit` helper (never `git add`/`git commit`):

```python
d = await commit.draft()
await d.commit("Docs: Add Flatpak packaging plan", [
    "- Record the Flathub-compliant packaging design, build steps and verification",
])
```

0.3 Confirm the commit contains exactly that path (`git log --oneline -1 --name-only`) and `git status --porcelain docs/` is empty.

0.4 Work steps 1-4 with changes uncommitted; when verification passes, commit them as a second commit with the same helper: `"Build: Add Flathub packaging for Caspion"` plus body lines `- Build the app from source offline with flatpak-node-generator sources` / `- Add manifest, launcher, desktop file, metainfo and launcher/build scripts` / `- Disable Chromium sandbox and auto-update inside the Flatpak sandbox`. Never commit `dist/`, `flatpak/build-dir`, `flatpak/repo`, `flatpak/.flatpak-builder` or `flatpak/*.flatpak`.

### Step 1 — Flatpak-aware main process (no behavior change outside Flatpak)

1.1 New file `packages/main/src/platform.ts` (no equivalent exists; no flatpak detection anywhere in the repo):

```ts
import { existsSync } from 'node:fs';

/**
 * Flatpak runs the app inside a bubblewrap sandbox and exports FLATPAK_ID plus a
 * /.flatpak-info marker file. Both are absent for deb/AppImage/dev runs.
 */
export const isFlatpak = Boolean(process.env.FLATPAK_ID) || existsSync('/.flatpak-info');

/**
 * Chromium's own sandbox cannot initialise inside the Flatpak sandbox: the setuid
 * helper is stripped and unprivileged user namespaces are unavailable. The Flatpak
 * (bubblewrap) sandbox is the isolation boundary for these helper browsers, so the
 * puppeteer-launched Chromium runs with its sandbox disabled.
 */
export const FLATPAK_CHROMIUM_ARGS: readonly string[] = ['--no-sandbox', '--disable-dev-shm-usage'];

export function getFlatpakChromiumArgs(flatpak: boolean = isFlatpak): string[] {
  return flatpak ? [...FLATPAK_CHROMIUM_ARGS] : [];
}
```

1.2 `packages/main/src/backend/import/bankScraper.ts` — only puppeteer-core arg construction in the repo (`grep -rn "getProxyArgs" packages/main/src` returns exactly this file). Delete the line `  const proxyArgs = getProxyArgs();` and change

```ts
    args: proxyArgs, // Add proxy configuration browser args
```

to

```ts
    args: [...getProxyArgs(), ...getFlatpakChromiumArgs()], // proxy + Flatpak sandbox browser args
```

Add after the existing `import { getProxyArgs } from '@/backend/proxyConfig';`:

```ts
import { getFlatpakChromiumArgs } from '@/platform';
```

1.3 `packages/main/src/index.ts` — electron-updater must not run under Flatpak (it would write into read-only `/app`). Add `import { isFlatpak } from './platform';` beside the other `./`-relative imports (`./handlers`, `./logging/operationLogger`, …) and change

```ts
if (import.meta.env.PROD && !isCliScrape) {
```

to

```ts
if (import.meta.env.PROD && !isCliScrape && !isFlatpak) {
```

1.4 `packages/main/src/handlers/updater.ts` — guard the three IPC handlers so the UI's update button reports "no updates" instead of an error. Add `import { isFlatpak } from '../platform';` and convert the three concise-arrow exports to block bodies:

```ts
export const checkForUpdate = async (): Promise<UpdateInfo | false> => {
  if (isFlatpak) {
    logger.info('Updates are managed by Flatpak, skipping update check');
    return false;
  }
  return new Promise<UpdateInfo | false>((resolve, reject) => {
    // existing body unchanged
  });
};

export const downloadUpdate = async (): Promise<electronUpdater.UpdateDownloadedEvent> => {
  if (isFlatpak) {
    throw new Error('Updates are managed by Flatpak, not by the app');
  }
  return new Promise<electronUpdater.UpdateDownloadedEvent>((resolve, reject) => {
    // existing body unchanged
  });
};

export const quitAndInstall = (): void => {
  if (isFlatpak) {
    return;
  }
  logger.info('Quitting and installing update');
  setImmediate(() => autoUpdater.quitAndInstall());
};
```

1.5 New test `packages/main/tests/platform.spec.ts` (the puppeteer path cannot run without bank credentials, so pin the flag decision here):

```ts
import { expect, test } from 'vitest';
import { FLATPAK_CHROMIUM_ARGS, getFlatpakChromiumArgs } from '../src/platform';

test('Chromium sandbox opt-out flags are added only inside Flatpak', () => {
  expect(getFlatpakChromiumArgs(true)).toEqual([...FLATPAK_CHROMIUM_ARGS]);
  expect(getFlatpakChromiumArgs(false)).toEqual([]);
});
```

Import only `../src/platform` (node:fs only); importing `bankScraper` would pull electron-log/electron into the test process.

Gate: `yarn typecheck:main` and `yarn test:main` pass (install yarn first: `npm install -g yarn@1`).

### Step 2 — Flathub-side files (all in `flatpak/`, which becomes the submission repo root verbatim)

2.1 `flatpak/io.github.brafdlog.Caspion.yml`:

```yaml
id: io.github.brafdlog.Caspion
runtime: org.freedesktop.Platform
runtime-version: '26.08'
sdk: org.freedesktop.Sdk
base: org.electronjs.Electron2.BaseApp
base-version: '26.08'
sdk-extensions:
  - org.freedesktop.Sdk.Extension.node22
command: caspion
separate-locales: false
finish-args:
  - --share=ipc
  - --share=network
  - --socket=fallback-x11
  - --socket=wayland
  - --device=dri
  - --talk-name=org.freedesktop.secrets
  - --filesystem=xdg-documents
  - --env=ELECTRON_TRASH=gio
  - --env=XCURSOR_PATH=/run/host/user-share/icons:/run/host/share/icons
modules:
  - name: libsecret
    buildsystem: meson
    config-opts:
      - -Dmanpage=false
      - -Dcrypto=disabled
      - -Dvapi=false
      - -Dgtk_doc=false
      - -Dintrospection=false
      - -Dbash_completion=disabled
    cleanup:
      - /bin
      - /include
      - /lib/pkgconfig
      - /share/man
    sources:
      - type: archive
        url: https://download.gnome.org/sources/libsecret/0.21/libsecret-0.21.7.tar.xz
        sha256: 6b452e4750590a2b5617adc40026f28d2f4903de15f1250e1d1c40bfd68ed55e
  - name: caspion
    buildsystem: simple
    build-options:
      append-path: /usr/lib/sdk/node22/bin
      env:
        XDG_CACHE_HOME: /run/build/caspion/flatpak-node/cache
        electron_config_cache: /run/build/caspion/flatpak-node/cache/electron
        npm_config_cache: /run/build/caspion/flatpak-node/npm-cache
        npm_config_offline: 'true'
        npm_config_build_from_source: 'true'
        npm_config_target: 39.8.5
        npm_config_runtime: electron
        npm_config_nodedir: /run/build/caspion/flatpak-node/cache/node-gyp/39.8.5
    build-commands:
      - HOME=$PWD yarn config --offline set yarn-offline-mirror $FLATPAK_BUILDER_BUILDDIR/flatpak-node/yarn-mirror
      - ln -s $XDG_CACHE_HOME/node-gyp $HOME/.electron-gyp
      - yarn --offline --frozen-lockfile
      - |
        node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));p.desktopName="io.github.brafdlog.Caspion.desktop";fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'
      - MODE=production yarn build
      - . flatpak-node/electron-builder-arch-args.sh; node_modules/.bin/electron-builder build --config electron-builder.yml --dir --publish never $ELECTRON_BUILDER_ARCH_ARGS
      - cp -a dist/linux*unpacked /app/caspion
      - install -Dm755 caspion-launcher.sh /app/bin/caspion
      - install -Dm644 io.github.brafdlog.Caspion.desktop /app/share/applications/io.github.brafdlog.Caspion.desktop
      - install -Dm644 io.github.brafdlog.Caspion.metainfo.xml /app/share/metainfo/io.github.brafdlog.Caspion.metainfo.xml
      - install -Dm644 io.github.brafdlog.Caspion.png /app/share/icons/hicolor/512x512/apps/io.github.brafdlog.Caspion.png
      - install -Dm644 LICENSE /app/share/licenses/io.github.brafdlog.Caspion/LICENSE
    sources:
      - type: git
        url: https://github.com/brafdlog/caspion.git
        commit: 0f634666a8ee26cab53cb72065dcb7ac85f5db05
      - type: patch
        path: patches/0001-flatpak-runtime-support.patch
      - generated-sources.json
      - type: file
        path: caspion-launcher.sh
      - type: file
        path: io.github.brafdlog.Caspion.desktop
      - type: file
        path: io.github.brafdlog.Caspion.metainfo.xml
      - type: file
        path: io.github.brafdlog.Caspion.png
```

Rationale for the load-bearing values: `--talk-name=org.freedesktop.secrets` for keytar/libsecret; `--filesystem=xdg-documents` because `defaultCsvPath`/`defaultJsonPath` point at `~/Documents` and scheduled CSV/JSON exports write there without a dialog; `--share=ipc` is required by the linter whenever `--socket=fallback-x11` is used; `--socket=x11` must not appear together with `fallback-x11` (linter error); `desktopName` is injected at build time only, so the deb build keeps its own desktop file name.

2.2 `flatpak/caspion-launcher.sh` (0755):

```sh
#!/bin/sh
# Flatpak entry point. Per-app TMPDIR, then Electron via zypak so Chromium's
# sandbox is redirected to the Flatpak sandbox.
set -eu

export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"

exec zypak-wrapper /app/caspion/caspion --ozone-platform-hint=auto "$@"
```

2.3 `flatpak/io.github.brafdlog.Caspion.desktop`:

```ini
[Desktop Entry]
Name=Caspion
Comment=Automated expense tracking from Israeli banks and credit cards
Exec=caspion
Icon=io.github.brafdlog.Caspion
Terminal=false
Type=Application
Categories=Office;
Keywords=expenses;budget;ynab;bank;finance;
StartupNotify=true
StartupWMClass=io.github.brafdlog.Caspion
```

(`Finance` is not a valid AppStream category and would be an `appstream-failed-validation` error; `Office` is.)

2.4 `flatpak/io.github.brafdlog.Caspion.metainfo.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>io.github.brafdlog.Caspion</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <name>Caspion</name>
  <summary>Automated expense tracking from Israeli banks and credit cards</summary>
  <developer id="io.github.brafdlog">
    <name>brafdlog</name>
  </developer>
  <description>
    <p>Caspion fetches transactions from Israeli banks and credit cards and exports them to Google Sheets, YNAB, CSV or JSON files.</p>
  </description>
  <launchable type="desktop-id">io.github.brafdlog.Caspion.desktop</launchable>
  <url type="homepage">https://github.com/brafdlog/caspion</url>
  <url type="bugtracker">https://github.com/brafdlog/caspion/issues</url>
  <categories>
    <category>Office</category>
  </categories>
  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/brafdlog/caspion/master/flatpak/screenshots/main-window.png</image>
      <caption>Accounts and exporters configuration</caption>
    </screenshot>
  </screenshots>
  <content_rating type="oars-1.1"/>
  <releases>
    <release version="2.19.9" date="2026-09-22"/>
  </releases>
</component>
```

(`metainfo-missing-screenshots`, `content-rating-missing`, `releases-info-missing`, `desktop-app-launchable-omitted` are Flathub linter errors; the screenshot is committed in step 4 and the URL only resolves after the change lands on `master`, which is fine because submission happens after merge.)

2.5 `flatpak/io.github.brafdlog.Caspion.png` — copy `buildResources/icon.png` (512×512, 85709 bytes) unchanged: `cp buildResources/icon.png flatpak/io.github.brafdlog.Caspion.png`.

2.6 `flatpak/build.sh` (0755):

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLATPAK_DIR="${REPO_ROOT}/flatpak"
APP_ID="io.github.brafdlog.Caspion"

cd "${REPO_ROOT}"

# Tooling in the user installation: no root, no distro flatpak-builder required.
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.flatpak.Builder

flatpak run --user --command=flatpak-builder --share=network --filesystem=home org.flatpak.Builder \
  --user --install --force-clean --disable-rofiles-fd \
  --state-dir="${FLATPAK_DIR}/.flatpak-builder" \
  --repo="${FLATPAK_DIR}/repo" \
  --install-deps-from=flathub \
  "${FLATPAK_DIR}/build-dir" \
  "${FLATPAK_DIR}/${APP_ID}.yml"

flatpak build-bundle "${FLATPAK_DIR}/repo" "${FLATPAK_DIR}/${APP_ID}.flatpak" "${APP_ID}"
```

2.7 `flatpak/README.md` — write exactly these sections:
- **Build**: `bash flatpak/build.sh`; prerequisites (`flatpak`, internet for sources, ~2 GB for SDK/BaseApp/node22 extension, first run slow).
- **Run / CLI**: `flatpak run io.github.brafdlog.Caspion`, `flatpak run io.github.brafdlog.Caspion --scrape`; data in `~/.var/app/io.github.brafdlog.Caspion` (`config/caspion/config.encrypt`, downloaded Chromium), secrets in the desktop keyring, updates via `flatpak update` (in-app updater disabled).
- **Regenerate dependency sources** (only when `yarn.lock` changes): `uvx --from "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node" flatpak-node-generator yarn yarn.lock --electron-node-headers -o flatpak/generated-sources.json` then verify `flatpak-node/cache/node-gyp/` version matches `electron` in `yarn.lock` and update `npm_config_target`/`npm_config_nodedir` in the manifest if the Electron version changed.
- **Submitting to Flathub**: fork `flathub/flathub`, `git checkout --track origin/new-pr`, copy everything in `flatpak/` to the repo root, commit, PR; quote the permission justifications (`org.freedesktop.secrets` = keytar config/credential storage; `xdg-documents` = scheduled CSV/JSON exports).
- **Maintenance after the Flatpak changes are merged and released**: delete `patches/0001-flatpak-runtime-support.patch` and its `- type: patch` entry, bump the `type: git` `commit:` to the release commit, and update `<release version= date=>` in the metainfo.

2.8 `.gitignore` — append:

```text
# flatpak packaging artifacts
/flatpak/build-dir
/flatpak/repo
/flatpak/.flatpak-builder
/flatpak/*.flatpak
```

2.9 Root `README.md` — in the CLI Mode code block, add under the existing `# Linux` line:

```bash
# Flatpak
flatpak run io.github.brafdlog.Caspion --scrape
```

and after `### Building production` add:

```markdown
### Building a Flatpak (Linux)

The Flatpak builds the app from source inside the sandbox, so it needs `flatpak` only (no root, no distro `flatpak-builder`):

```bash
bash flatpak/build.sh
```

This installs `io.github.brafdlog.Caspion` for the current user and writes `flatpak/io.github.brafdlog.Caspion.flatpak`. See [`flatpak/README.md`](flatpak/README.md) for running it, regenerating dependency sources and the Flathub submission steps.
```

### Step 3 — Generate the patch and the vendored dependency sources

3.1 Produce the runtime patch from the Step 1 edits (working tree is clean at `0f63466`, so contexts match the pinned commit exactly):

```bash
mkdir -p flatpak/patches
git add -N packages/main/src/platform.ts
git diff -- packages/main/src/platform.ts packages/main/src/backend/import/bankScraper.ts packages/main/src/index.ts packages/main/src/handlers/updater.ts > flatpak/patches/0001-flatpak-runtime-support.patch
git reset -- packages/main/src/platform.ts
```

The patch must contain four file diffs (three modified, one new) and no test file. If `git diff` prints nothing, the Step 1 edits are missing — stop and redo Step 1.

3.2 Generate the offline dependency list (needs network; ~1.3 MB output for this lockfile):

```bash
uvx --from "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node" \
  flatpak-node-generator yarn yarn.lock --electron-node-headers -o flatpak/generated-sources.json
```

Check the result before building: `jq -r '.[] | select(.url? // "" | test("electron-v39|node-v39.8.5-headers")) | .url + " -> " + (.dest // "")' flatpak/generated-sources.json` must list the `electron-v39.8.5-linux-x64.zip` (and arm64) archives plus a `node-v39.8.5-headers.tar.gz` extracting to `flatpak-node/cache/node-gyp/39.8.5`; if the headers version differs, use that directory in `npm_config_nodedir`. If the file exceeds 25 MB (Flathub `manifest-directory-too-large`), rerun with `-s` and replace the single `generated-sources.json` entry with every `generated-sources.N.json` it produces.

### Step 4 — Build, install, capture the screenshot

4.1 `bash flatpak/build.sh` — expect a successful build and `flatpak list --user | grep Caspion`.

4.2 Run and screenshot:

```bash
flatpak run io.github.brafdlog.Caspion &
sleep 15
niri msg windows                      # note the id of the "Caspion" window
niri msg action focus-window --id <id>
niri msg action screenshot-window
ls -t ~/Pictures/Screenshots/*.png | head -1
```

Copy that PNG to `flatpak/screenshots/main-window.png` (create the directory). If `niri msg action screenshot-window` is unavailable, use `spectacle --background --nonotify --output flatpak/screenshots/main-window.png`.

## Verification

Run from the repo root; expected result in parentheses.

0. `git log --oneline -1 --name-only` — the only path listed is `docs/flatpak-packaging-plan.md` (the plan commit landed first, before any code change).
1. `yarn test:main` — `platform.spec.ts` passes, other suites unchanged.
2. `yarn typecheck:main` — clean.
3. `bash flatpak/build.sh` — exits 0; `flatpak list --user --columns=application,version | grep Caspion` shows `io.github.brafdlog.Caspion` and `2.19.9`.
4. Manifest lints clean:

```bash
flatpak run --user --command=flatpak-builder-lint org.flatpak.Builder manifest flatpak/io.github.brafdlog.Caspion.yml; echo "exit=$?"
```

(no `appid-*`, `module-*`, `finish-args-*`, `appstream-*` errors; warnings only from runtime checks are acceptable). Then the repo check:

```bash
cd flatpak && flatpak run --user --command=flatpak-builder-lint org.flatpak.Builder repo repo; echo "exit=$?"
```

5. Metadata validators: `appstreamcli validate --no-net flatpak/io.github.brafdlog.Caspion.metainfo.xml` and `desktop-file-validate flatpak/io.github.brafdlog.Caspion.desktop` — both exit 0.
6. Sandbox identity + installed files:

```bash
flatpak run --command=sh io.github.brafdlog.Caspion -c 'echo "$FLATPAK_ID"; ls /app/share/applications /app/share/metainfo /app/share/icons/hicolor/512x512/apps /app/share/licenses/io.github.brafdlog.Caspion'
```

(prints `io.github.brafdlog.Caspion` and the four installed metadata files).
7. Window + app id: `flatpak run io.github.brafdlog.Caspion`, then `niri msg windows` (window App ID is `io.github.brafdlog.Caspion`, matching `StartupWMClass`/`desktopName`), and `flatpak ps` lists the app.
8. Logs after quitting: `grep -E "APP_READY|UPDATE_CHECK" ~/.var/app/io.github.brafdlog.Caspion/config/caspion/logs/main.log` — `APP_READY` present, no `UPDATE_CHECK`/`UPDATE_CHECK_ERROR` lines.
9. keytar/libsecret round-trip: in the running app toggle a setting (e.g. "show browser"), quit, `ls ~/.var/app/io.github.brafdlog.Caspion/config/caspion/config.encrypt` (exists), reopen and confirm the setting persisted.
10. Puppeteer Chromium inside the sandbox: run `flatpak run io.github.brafdlog.Caspion --scrape` (no accounts configured; it downloads Chromium then finishes), then

```bash
flatpak run --command=sh io.github.brafdlog.Caspion -c 'CHROME=$(find "$HOME/.var/app/io.github.brafdlog.Caspion/config" -name chrome -type f | head -1); "$CHROME" --headless=new --no-sandbox --disable-dev-shm-usage --dump-dom about:blank'
```

(prints an `<html>` document — the browser the scraper launches starts under the flags added in Step 1).
11. Documents access (justifies `xdg-documents`):

```bash
flatpak run --command=sh io.github.brafdlog.Caspion -c 'touch "$HOME/Documents/.caspion-flatpak-test" && rm "$HOME/Documents/.caspion-flatpak-test" && echo write-ok'
```

(prints `write-ok`).
12. Bundle: `ls -l flatpak/io.github.brafdlog.Caspion.flatpak` (non-empty) and `flatpak install --user --reinstall -y flatpak/io.github.brafdlog.Caspion.flatpak` succeeds.
13. Screenshot committed at `flatpak/screenshots/main-window.png` and shows the Caspion UI (not a black/empty frame).

## Critical files & anchors

- `packages/main/src/backend/import/bankScraper.ts` — `const proxyArgs = getProxyArgs();` and `args: proxyArgs,` are the entire puppeteer arg wiring.
- `packages/main/src/index.ts` — `if (import.meta.env.PROD && !isCliScrape) {` auto-update block (line ~124).
- `packages/main/src/handlers/updater.ts` — three concise-arrow exports (`checkForUpdate`, `downloadUpdate`, `quitAndInstall`) to convert to block bodies with guards.
- `electron-builder.yml` — `linux.target: deb` and `files`; with `--dir` no target is built, output dir is `dist/linux-unpacked` (aarch64: `dist/linux-arm64-unpacked`, hence the `dist/linux*unpacked` glob in the manifest).
- `scripts/update-electron-vendors.js` — runs from the root `postinstall` via the Electron binary and writes `.electron-vendors.cache.json` + `.browserslistrc`, which the three `vite.config.js` files import; it must succeed during `yarn --offline` for `yarn build` to work.

## Assumptions & contingencies

- Network: `flatpak-builder` fetches the git commit, npm tarballs, Electron zip/headers and the libsecret archive on the host side of the build; the build itself stays offline (`--share=network` is passed to the Builder app, not as a build-arg).
- If `yarn: command not found` inside the build, add a yarn source and call it explicitly:
  `- type: archive` / `url: https://github.com/yarnpkg/yarn/releases/download/v1.22.22/yarn-v1.22.22.tar.gz` / `sha256: 88268464199d1611fcf73ce9c0a6c4d44c7d5363682720d8506f6508addf36a0`, then replace every `yarn` in `build-commands` with `node yarn-v1.22.22/bin/yarn.js`.
- If `yarn --offline` fails resolving a package (`Couldn't find any versions…` / missing tarball), regenerate in step 3.2 with `--no-requests-cache`, and confirm `generated-sources.json` still lists that package.
- If keytar fails with `Package libsecret-1 was not found in the pkg-config search path`, add `PKG_CONFIG_PATH: /app/lib/pkgconfig:/app/share/pkgconfig` to the module `env`.
- If keytar/node-gyp fails on headers (`Cannot find module …/cache/node-gyp/…`), check the actual directory with `ls /run/build/caspion/flatpak-node/cache/node-gyp/` in the build log (or `grep -o 'cache/node-gyp/[^"]*' flatpak/generated-sources.json | sort -u`) and point `npm_config_nodedir` at it.
- If electron extraction fails during `yarn --offline` (`@electron/get` checksum/EACCES), confirm the zips landed at `flatpak-node/cache/electron/electron-v39.8.5-linux-x64.zip` and add `ELECTRON_SKIP_BINARY_DOWNLOAD: '1'` only if you also drop the root `postinstall` electron invocation via the patch (it is needed for `.electron-vendors.cache.json`).
- If `electron-builder` tries to fetch something (fpm/AppImage), keep `--dir` and add `-c.linux.target=dir`; if it insists on rebuilding with network, add `-c.npmRebuild=false` (keytar is already N-API/electron-ABI from `yarn --offline`).
- If the app aborts with a Chromium sandbox error (`No usable sandbox`, `SUID sandbox helper`), change the launcher's `exec` to `exec /app/caspion/caspion --no-sandbox --ozone-platform-hint=auto "$@"`.
- If the window is blank under Wayland, verify with `flatpak run --nosocket=wayland io.github.brafdlog.Caspion`; if that fixes it, replace `--socket=fallback-x11`+`--socket=wayland` with `--socket=x11` in `finish-args` (keep `--share=ipc`).
- If the linter reports `appstream-external-screenshot-url`, the screenshot URL is not reachable/mirrorable yet — it must exist on `master` before the submission PR; until then keep the local file and submit after merge.
- Not a packaging defect: `.env` is committed with empty `VITE_GOOGLE_CLIENT_ID`/`VITE_GOOGLE_CLIENT_SECRET`, so Google Sheets login is unavailable in any build from this repo; leave OAuth code untouched.
