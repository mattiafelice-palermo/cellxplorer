# Spec 021: Side-by-side Stable and Beta application identities

Status: **in progress**  
Target branch: `feature/stable-beta-app-identities`  
Review document: `docs/specs/reviews/021-stable-beta-app-identities-review.md`

## Implementation record

- Channel modules: `frontend/src/appChannel.ts`, `src-tauri/src/app_channel.rs`.
- Beta overlay: `src-tauri/tauri.beta.conf.json`; icons via `scripts/build_beta_icons.py`.
- Build: `scripts/build-app.ps1 -Channel stable|beta`; npm `tauri:build:stable|beta`.
- Beta updater commands fail closed in `app_updates.rs` until Spec 023.
- Teal audit: only shell brand/active controls and scrollbars were made channel-aware;
  semantic success, plots, thumbnails, and exports remain teal.

## 1. Goal

Create two genuinely separate Windows application identities from the same source tree:

- **CellXplorer** — the stable application;
- **CellXplorer Beta** — an opt-in preview application that can be installed and run beside stable.

This specification owns application identity, installer identity, runtime identity, icons, title-bar
branding and beta UI color. It does **not** yet copy stable data into Beta or publish separate updater
feeds; those are Specs 022 and 023.

The implementation must not merely select a different installation folder. Windows, Tauri and the
user must all recognize Stable and Beta as different products.

## 2. Release-train rule

Specs 021, 022 and 023 form one coordinated release train.

- Implement and review them sequentially.
- Merge Spec 021 before starting Spec 022.
- Do not tag or publish a user-facing Stable or Beta release after Spec 021 or Spec 022 alone.
- Spec 023 owns the first complete channel release and the synchronized version/changelog decision.
- Intermediate build-only artifacts are allowed for disposable installation tests.
- Never install an intermediate Beta build against the user's real `%USERPROFILE%\.cellxplorer`
  data. Use a disposable Windows account or an explicit `CELLXPLORER_DATA` test directory until
  Spec 022 is complete.

## 3. Locked identity matrix

These values are fixed. Do not rename or infer them from the version string.

| Property | Stable | Beta |
|---|---|---|
| Internal channel | `stable` | `beta` |
| Product name | `CellXplorer` | `CellXplorer Beta` |
| Tauri identifier | `com.cellxplorer.desktop` | `com.cellxplorer.desktop.beta` |
| Main window title | `CellXplorer` | `CellXplorer Beta` |
| Default install folder | `Program Files\CellXplorer` | `Program Files\CellXplorer Beta` |
| Windows uninstall display name | `CellXplorer` | `CellXplorer Beta` |
| Start-menu/desktop shortcut name | `CellXplorer` | `CellXplorer Beta` |
| Autostart registry value | `CellXplorer` | `CellXplorer Beta` |
| Deep-link scheme | `cellxplorer://` | `cellxplorer-beta://` |
| Single-instance domain | stable identifier | beta identifier |
| Tray tooltip/menu product name | `CellXplorer` | `CellXplorer Beta` |
| Default data root | unchanged for now | unchanged for now; Spec 022 separates it |
| Update behavior before Spec 023 | existing stable feed | update commands disabled fail-closed |

Stable values must remain backward compatible with currently installed Stable copies.

## 4. Locked Beta visual design

The Beta edition must be unmistakable without becoming visually loud.

### 4.1 Beta color family

Stable remains unchanged and keeps Mantine `teal`.

Beta uses a dedicated Mantine palette named `betaBlue`:

```ts
const betaBlue = [
  "#eef7ff",
  "#dceeff",
  "#badcff",
  "#96c9f2",
  "#7db7e8",
  "#61a3dc",
  "#478dcd",
  "#3678b7",
  "#2d659f",
  "#265487",
] as const;
```

Use:

```ts
primaryColor: "betaBlue"
primaryShade: { light: 7, dark: 6 }
```

Rationale locked into the design:

- `#7DB7E8` is the visible pastel-blue brand color for icons and light accents;
- darker shades are used for filled controls and white text so contrast remains usable;
- no gradient, glow, animation or second decorative palette is introduced.

The native Windows caption/border color for Beta is `#3678B7`; its caption text remains white.
Stable keeps its current teal native frame.

### 4.2 Header identity

The existing header title group contains the application icon and `CellXplorer` title.

For Beta:

```text
[blue app icon] CellXplorer [BETA]
```

The `BETA` badge is:

- immediately to the right of the `CellXplorer` title, not in the utility-button group;
- uppercase text `BETA`;
- white text;
- filled `betaBlue.7`;
- compact (`Badge size="xs"` or equivalent established geometry);
- no outline, icon, tooltip or animation;
- vertically aligned with the title;
- visible at every route and UI zoom.

Stable renders no badge.

### 4.3 Icons

Beta uses a distinct icon set:

- preserve the exact CellXplorer icon geometry and transparency;
- replace the stable teal brand pixels with pastel blue `#7DB7E8`;
- preserve neutral, white and dark details;
- do not add tiny text, a Greek beta symbol or another overlay that becomes unreadable at 16 px.

Required committed assets include all formats needed by the existing build:

```text
frontend/public/app-icon-beta.png
src-tauri/icons-beta/icon.ico
src-tauri/icons-beta/icon.png
src-tauri/icons-beta/icon-256.rgba
```

Generate any additional Tauri-required sizes through one deterministic script, for example
`scripts/build_beta_icons.py`. The script must derive Beta icons from the committed Stable source
asset and must not overwrite Stable icons.

Verify the Beta icon at 16, 24, 32, 48 and 256 px. Stable assets must remain byte-for-byte unchanged.

### 4.4 Color semantics

Channel color replaces teal only where teal currently means **application primary/brand/active**:

- primary buttons and selected controls;
- active navigation or primary progress;
- update indicator;
- branded scrollbars;
- native window frame;
- Beta icon and Beta badge.

Do not perform a blind repository-wide `teal -> blue` replacement.

Keep existing semantic colors:

- success may remain teal;
- warnings remain yellow/orange;
- errors/destructive actions remain red;
- neutral state remains gray;
- draft/unsaved behavior remains yellow;
- Plotly palettes, trace colors, stored styles, thumbnails and exports remain unchanged.

## 5. Current implementation anchors

Read these before editing.

### Tauri and installer

- `src-tauri/tauri.conf.json`
  - `productName`
  - `identifier`
  - `app.windows[0].title`
  - `plugins.deep-link.desktop.schemes`
  - `bundle.icon`
  - `bundle.windows.nsis.*`
- `src-tauri/cellxplorer-installer.nsi`
  - `PRODUCTNAME`
  - `UNINSTKEY`
  - `MANUPRODUCTKEY`
  - `PLACEHOLDER_INSTALL_DIR`
- `src-tauri/src/main.rs`
  - `apply_window_frame_color_to_hwnd`
  - `apply_window_icon`
  - `queue_deep_link`
  - `startup_mode`
  - `autostart_status`
  - `update_autostart`
  - `set_tray_status`
  - `app_data_dir`
  - single-instance initialization
  - tray construction and labels
  - backend sidecar environment

The custom NSIS template already derives install folder and uninstall keys from `PRODUCTNAME`.
Changing the product name through a Beta configuration overlay must produce separate Windows
registration; do not create a second copied NSIS template unless the existing template cannot be
made channel-aware.

### Frontend

- `frontend/src/main.tsx`
  - current Mantine `primaryColor: "teal"`
- `frontend/src/App.tsx`
  - header `/app-icon.png`
  - `<Title order={4}>CellXplorer</Title>`
  - explicit primary-color uses in shell progress/actions
- `frontend/src/app.css`
  - `.cx-vertical-scroll` teal variables
- `docs/agent-knowledge/visual-style-guide.md`

### Build and tests

- `scripts/build-app.ps1`
- root `package.json`
- `scripts/check_versions.py`
- `tests/test_updater_configuration.py`
- packaging tests under `tests/`
- `docs/windows-packaging.md`
- `docs/tauri-packaging-lessons.md`

## 6. Channel model

Create one small shared frontend channel module:

```text
frontend/src/appChannel.ts
```

Required shape:

```ts
export type AppChannel = "stable" | "beta";

export type AppBranding = {
  channel: AppChannel;
  productName: "CellXplorer" | "CellXplorer Beta";
  shortName: "CellXplorer" | "CellXplorer Beta";
  isBeta: boolean;
  primaryColor: "teal" | "betaBlue";
  appIconPath: "/app-icon.png" | "/app-icon-beta.png";
};

export const APP_CHANNEL: AppChannel;
export const APP_BRANDING: AppBranding;
```

Rules:

- read `import.meta.env.VITE_CELLXPLORER_CHANNEL`;
- browser development defaults to `stable` only when the variable is absent;
- any non-empty unsupported value must throw during startup/build rather than silently becoming
  stable;
- never infer Beta from `APP_VERSION`, `-beta`, Git tag, product name or update preference;
- add the appropriate Vite environment typing.

Create a Rust equivalent, preferably:

```text
src-tauri/src/app_channel.rs
```

Rust must derive the installed channel from the configured Tauri identifier:

```rust
com.cellxplorer.desktop       -> Stable
com.cellxplorer.desktop.beta  -> Beta
anything else                 -> startup error
```

The identifier is authoritative inside the packaged application. Centralize helpers for:

- product name;
- autostart registry value;
- deep-link scheme/prefix;
- tray labels/tooltips;
- native frame color;
- channel string passed to the sidecar.

Do not scatter string comparisons through `main.rs`.

## 7. Tauri Beta configuration

Keep `src-tauri/tauri.conf.json` as the Stable source of truth.

Add a merge overlay:

```text
src-tauri/tauri.beta.conf.json
```

It must override only Beta-specific configuration:

```json
{
  "productName": "CellXplorer Beta",
  "identifier": "com.cellxplorer.desktop.beta",
  "app": {
    "windows": [
      {
        "title": "CellXplorer Beta",
        "width": 1400,
        "height": 900,
        "minWidth": 1100,
        "minHeight": 720
      }
    ]
  },
  "plugins": {
    "deep-link": {
      "desktop": {
        "schemes": ["cellxplorer-beta"]
      }
    }
  },
  "bundle": {
    "icon": ["icons-beta/icon.ico"],
    "windows": {
      "nsis": {
        "installerIcon": "icons-beta/icon.ico",
        "uninstallerIcon": "icons-beta/icon.ico"
      }
    }
  }
}
```

Preserve the current NSIS template, installer hooks, sidecar, compression and per-machine mode.

Tests must resolve the Stable configuration plus overlay and assert the final values. Do not merely
grep the overlay.

## 8. Build commands

Extend `scripts/build-app.ps1`:

```powershell
.\scripts\build-app.ps1 -Channel stable
.\scripts\build-app.ps1 -Channel beta
```

Contract:

- `-Channel` accepts only `stable` or `beta`;
- default is `stable` for backward compatibility;
- Stable builds use the default Tauri config;
- Beta builds add `--config src-tauri/tauri.beta.conf.json`;
- set `VITE_CELLXPLORER_CHANNEL` before the frontend build;
- preserve the existing backend fingerprint and skip behavior;
- include channel/config/icon inputs in the relevant build fingerprint;
- print the channel and final installer path;
- when locating the output, require the expected product-specific filename instead of selecting an
  arbitrary newest setup executable.

Add explicit npm scripts if useful:

```json
"tauri:build:stable": "tauri build",
"tauri:build:beta": "tauri build --config src-tauri/tauri.beta.conf.json"
```

Do not duplicate the whole build pipeline into separate scripts.

## 9. Rust shell changes

Make these channel-aware through `app_channel.rs`.

### Window frame and icon

- Stable frame remains current teal.
- Beta frame is `#3678B7`.
- Do not always overwrite the configured window icon with Stable
  `include_bytes!("../icons/icon-256.rgba")`.
- Either choose the correct embedded RGBA asset by channel or rely on the configured default icon,
  but verify the actual taskbar/window icon in both packages.

### Single instance

Stable and Beta must be able to run simultaneously. Two Stable launches still coalesce into Stable;
two Beta launches still coalesce into Beta.

Do not add another process lock. The distinct Tauri identifiers must provide separate application
domains.

### Deep links

Accept only the channel's scheme:

```text
Stable: cellxplorer://import-analysis
Beta:   cellxplorer-beta://import-analysis
```

Update:

- startup argument scan;
- single-instance argument handling;
- `queue_deep_link`;
- portable-report generated deep-link URLs in
  `backend/app/services/portable_analysis.py`;
- affected tests.

A Beta installation must not register or take ownership of `cellxplorer://`. Stable must not register
`cellxplorer-beta://`.

Pass `CELLXPLORER_CHANNEL=stable|beta` to the backend sidecar so backend-generated links use the
correct scheme. Invalid or absent channel values in packaged mode must fail safely; ordinary browser
development may default to stable.

### Autostart and tray

Use channel-specific product names for:

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value;
- tray tooltip;
- Open/Quit menu labels;
- startup text shown in Settings;
- native notification application identity.

Stable and Beta autostart settings must not overwrite each other.

## 10. Frontend theme and header

In `frontend/src/main.tsx`:

- construct the Mantine theme from `APP_BRANDING`;
- register `betaBlue` only once;
- Stable still uses teal;
- Beta uses `betaBlue` and the locked shades;
- preserve `defaultRadius: "md"` and Auto/Light/Dark behavior.

In `frontend/src/App.tsx`:

- use `APP_BRANDING.appIconPath`;
- use `APP_BRANDING.productName`;
- render the locked `BETA` badge only for Beta;
- use the channel primary color for brand/active shell controls;
- preserve header height, title geometry, utility actions and UI zoom.

In `frontend/src/app.css`:

- replace hardcoded brand scrollbar teal with Mantine primary variables, not Beta-specific CSS
  duplication.

Audit explicit teal usage in all frontend source and CSS. Reclassify each occurrence as:

1. brand/primary — make channel-aware;
2. semantic success — keep teal;
3. plot/persisted presentation — leave unchanged.

Record the audit briefly in the implementation record; do not broadly refactor unrelated components.

## 11. Temporary update safety before Spec 023

A Beta package built under Spec 021 must not consume the Stable updater feed.

Until Spec 023 introduces the Beta endpoint:

- `check_app_update`, `download_app_update` and `install_app_update` must reject the Beta channel
  with a safe explicit error;
- hide or disable application-update UI in Beta build-only artifacts;
- Stable updater behavior must remain unchanged;
- add a comment referencing Spec 023 so the temporary gate is removed deliberately;
- do not publish Beta artifacts from this intermediate state.

## 12. Expected files

Likely additions/changes:

```text
frontend/src/appChannel.ts
frontend/src/vite-env.d.ts
frontend/src/main.tsx
frontend/src/App.tsx
frontend/src/app.css
frontend/public/app-icon-beta.png
frontend/tests/appChannel.test.ts
src-tauri/tauri.beta.conf.json
src-tauri/src/app_channel.rs
src-tauri/src/main.rs
src-tauri/src/app_updates.rs
src-tauri/icons-beta/*
scripts/build_beta_icons.py
scripts/build-app.ps1
package.json
tests/test_app_channels.py
tests/test_updater_configuration.py
tests/test_portable_analysis.py
docs/specs/021-stable-beta-app-identities.md
docs/specs/README.md
docs/agent-knowledge/architecture.md
docs/agent-knowledge/change-playbooks.md
docs/windows-packaging.md
AGENTS.md
```

Do not create duplicate frontend trees, backend packages, NSIS templates or Cargo crates.

## 13. Tests

Add focused tests for:

### Channel policy

- missing Vite channel defaults to Stable in browser/dev policy;
- `stable` and `beta` map to exact locked branding;
- invalid values fail;
- Stable has no BETA badge;
- Beta badge text and icon path are exact;
- semantic success is not globally recolored.

### Configuration

- resolved Stable and Beta Tauri configs match the identity matrix;
- identifiers, product names, titles, schemes and icons differ;
- Stable values remain unchanged;
- both use the same NSIS template and sidecar;
- Beta update commands are fail-closed until Spec 023.

### Rust helpers

- exact identifier-to-channel mapping;
- unknown identifier rejection;
- channel-specific autostart names;
- channel-specific deep-link acceptance;
- channel-specific frame colors and product labels.

### Build script

- invalid channel exits non-zero;
- default equals Stable;
- Stable command does not use Beta overlay;
- Beta command uses the overlay and Beta Vite environment;
- artifact discovery expects the correct product name.

Run:

```powershell
node --test frontend\tests\appChannel.test.ts frontend\tests\appUpdater.test.ts
cd frontend
npx tsc --noEmit
npm.cmd run build
cd ..
python -m unittest tests.test_app_channels tests.test_updater_configuration tests.test_portable_analysis -v
cargo test --manifest-path src-tauri\Cargo.toml
cargo check --manifest-path src-tauri\Cargo.toml
python scripts\preflight.py --no-cache
```

Build both disposable installers:

```powershell
.\scripts\build-app.ps1 -Channel stable
.\scripts\build-app.ps1 -Channel beta
```

## 14. Manual Windows verification

Use a disposable Windows account or explicit disposable data root.

Verify:

1. Installed Apps lists `CellXplorer` and `CellXplorer Beta` separately.
2. Default installation directories differ.
3. Start-menu and desktop shortcuts are distinct.
4. Stable and Beta can run simultaneously.
5. A second Stable launch focuses Stable; a second Beta launch focuses Beta.
6. Stable and Beta have different taskbar, tray, installer and uninstall icons.
7. Stable frame/theme remains teal.
8. Beta frame/theme uses the locked blue family.
9. The white `BETA` badge is visible and aligned at 70%, 100%, 130% and 160% UI zoom.
10. Light, Dark and Auto remain legible.
11. `cellxplorer://` opens Stable only.
12. `cellxplorer-beta://` opens Beta only.
13. Stable and Beta autostart registry entries can coexist.
14. Uninstalling Beta leaves Stable installed and launchable; uninstalling Stable leaves Beta.
15. Intermediate Beta update checks are disabled and cannot install a Stable package.

Do not perform destructive uninstall tests against real user data.

## 15. Out of scope

- separate Beta data root or library copy;
- Stable-to-Beta installation UX;
- Beta updater feed and release workflow;
- database migrations or `CALC_VERSION`;
- changing scientific plot palettes or export palettes;
- redesigning the header, navigation or update modal;
- macOS/Linux package channels;
- Windows Authenticode;
- automatic Beta installation without confirmation.

## 16. Implementation order

1. Copy this spec into the repository and index it.
2. Confirm no feature branch is open; branch from current `main`.
3. Add channel policy modules and tests.
4. Add the Beta Tauri overlay and deterministic Beta icons.
5. Make build commands channel-aware.
6. Make Rust identity, frame, icon, deep link, autostart and tray behavior channel-aware.
7. Make frontend theme/header branding channel-aware.
8. Add the temporary Beta updater fail-closed gate.
9. Update focused tests and durable documentation.
10. Run all checks and build both installers.
11. Perform the disposable Windows identity matrix.
12. Record exact results; do not tag or publish.

## 17. Acceptance checklist

- [ ] Stable identity remains backward compatible.
- [ ] Beta has a separate product, identifier, installer, uninstall key and shortcuts.
- [ ] Stable and Beta can run simultaneously.
- [ ] Deep links and autostart entries do not conflict.
- [ ] Beta uses the distinct blue icon set.
- [ ] Beta uses the locked blue theme and white BETA badge.
- [ ] Stable remains teal and has no Beta branding.
- [ ] Plot and scientific presentation colors are unchanged.
- [ ] Build channel is explicit and invalid values fail.
- [ ] Intermediate Beta updater commands fail closed.
- [ ] Both installers build and pass the disposable Windows matrix.
- [ ] No user release is tagged before Specs 022 and 023.

## 18. Composer handoff

```text
Implement docs/specs/021-stable-beta-app-identities.md.

Read AGENTS.md, docs/agent-knowledge/README.md, architecture.md,
change-playbooks.md, visual-style-guide.md, docs/windows-packaging.md,
docs/tauri-packaging-lessons.md and docs/specs/README.md first.

Create feature/stable-beta-app-identities from current main only after confirming
that no other feature branch is active.

Use the exact Stable/Beta identity matrix and locked betaBlue palette in the spec.
Do not infer channel from a version string. Do not duplicate the app, backend or
NSIS template. Do not change scientific plot colors.

This is only Spec 021: keep Beta update commands fail-closed and do not tag or
publish a release. Use disposable data for installer tests because data isolation
belongs to Spec 022.
```
