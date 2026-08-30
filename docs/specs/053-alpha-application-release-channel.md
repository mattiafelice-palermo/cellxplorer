# Spec 053: Fully isolated Alpha application and release channel

Status: **Plan — non-implementable parent**
Repository: mattiafelice-palermo/cellxplorer
Target branch: codex/alpha-release-channel
Depends on: Specs 021, 022, and 023
User decision: Alpha is a fully isolated third Windows application, not an additional feed inside
Stable or Beta.
User amendment 2026-08-27: Alpha gains its own first-launch setup flow offering three explicit
choices — start empty, copy the Stable library, or copy the Beta library. This supersedes the
original "no cross-product copy" rule in §6.1 and the matching §13 exclusion. Child 053.3 owns it.

## 1. Goal

Add **CellXplorer Alpha** as a third Windows product built from the existing source tree.

After this parent and both children are complete:

- Stable, Beta, and Alpha can be installed and run side by side;
- each product has its own Windows identity, installation, process domain, deep link, profile root,
  updater feed, release tag family, installer branding, icon, and in-app channel identity;
- Alpha uses a restrained purple application theme and an explicit ALPHA badge;
- Alpha updates only Alpha, and neither Stable nor Beta installs or updates Alpha;
- Stable and Beta behavior remains backward compatible;
- release automation can build, verify, and eventually publish Alpha without changing either
  existing channel pointer.

This is one shared-code product family, not a fork or copied frontend/backend tree.

Spec 023 deliberately placed Alpha/canary/nightly outside the Stable/Beta release scope. Parent 053
is the new authority for Alpha only; it preserves every Stable/Beta safety, signing, draft,
immutability, and target-pointer gate unless this parent explicitly strengthens it for three
channels.

## 2. Why this is a parent feature

The work has two independently reviewable ownership boundaries:

1. **053.1 — Alpha application identity, isolation, and packaging**
   establishes the buildable installed product and proves local side-by-side isolation.
2. **053.2 — Alpha updater, release publication, and closure**
   extends tag policy, manifest validation, GitHub automation, the manifest-only channel branch,
   and the complete three-product installed/update matrix.
3. **053.3 — Alpha first-launch database bootstrap** (added by the 2026-08-27 user amendment)
   gives Alpha its own three-choice first-run setup flow — start empty, copy Stable, or copy Beta —
   by generalizing the verified Beta bootstrap machinery rather than duplicating it.

All children use the shared target branch. Implement and review them in numeric order.
Do not merge between children.

## 3. Locked definition of “fully isolated”

Alpha isolation covers:

- Windows bundle/product identifier;
- install directory, Installed Apps entry, uninstall key, shortcuts, and autostart value;
- Tauri single-instance domain;
- deep-link registration;
- profile data root, SQLite database, caches, imports, logs, backups, settings, and download history;
- updater endpoint and accepted release-version family;
- frontend channel stamp, app icon, native frame, installer color, product title, and badge;
- release manifest pointer and target-only publication guarantees.

The following infrastructure remains intentionally shared:

- repository and source code;
- React frontend, FastAPI backend, Python sidecar, Rust shell, and NSIS template;
- database schema and migration registry;
- GitHub repository and release workflow;
- existing Tauri updater public/private signing-key pair;
- scientific calculations, caches formats, plot palettes, and portable-report format.

Sharing those implementation assets does not weaken product isolation because no runtime state,
Windows identity, update pointer, or user profile is shared.

## 4. Locked three-product identity matrix

| Property | Stable | Beta | Alpha |
|---|---|---|---|
| Internal channel | stable | beta | alpha |
| Product name | CellXplorer | CellXplorer Beta | CellXplorer Alpha |
| Header composition | CellXplorer | CellXplorer + BETA | CellXplorer + ALPHA |
| Tauri identifier | com.cellxplorer.desktop | com.cellxplorer.desktop.beta | com.cellxplorer.desktop.alpha |
| Main window title | CellXplorer | CellXplorer Beta | CellXplorer Alpha |
| Default install folder | Program Files\CellXplorer | Program Files\CellXplorer Beta | Program Files\CellXplorer Alpha |
| Deep-link scheme | cellxplorer:// | cellxplorer-beta:// | cellxplorer-alpha:// |
| Default data root | %USERPROFILE%\.cellxplorer | %USERPROFILE%\.cellxplorer-beta | %USERPROFILE%\.cellxplorer-alpha |
| Frontend channel | stable | beta | alpha |
| Tauri overlay | none | src-tauri/tauri.beta.conf.json | src-tauri/tauri.alpha.conf.json |
| Header icon | /app-icon.png | /app-icon-beta.png | /app-icon-alpha.png |
| Mantine primary | teal | betaBlue | alphaPurple |
| Updater pointer | stable/latest.json | beta/latest.json | alpha/latest.json |
| Release tag | vX.Y.Z | vX.Y.Z-beta.N or retained legacy compact form | vX.Y.Z-alpha.N |
| GitHub release type | normal | prerelease | prerelease |
| NSIS setup prefix | CellXplorer_ | CellXplorer.Beta_ | CellXplorer.Alpha_ |

The environment variable CELLXPLORER_DATA remains the highest-priority exact data-root override in
all three products. Do not append a channel suffix when it is set.

## 5. Locked Alpha visual design

Alpha is purple-themed but remains a quiet scientific application. It inherits
docs/agent-knowledge/visual-style-guide.md except for the explicit channel-primary palette below.

Create a Mantine palette named alphaPurple:

    #f3f0ff
    #e5dbff
    #d0bfff
    #b197fc
    #9775fa
    #845ef7
    #7950f2
    #7048e8
    #6741d9
    #5f3dc4

Use primaryShade light 7 / dark 6. The native frame and NSIS brand color are #7048E8; the Windows
COLORREF value is 0x00E84870. The pastel icon brand replacement color is #B197FC.

The Alpha header is:

    [purple app icon] CellXplorer [ALPHA]

The ALPHA badge uses white uppercase text, alphaPurple.7, compact existing badge geometry, and no
animation, gradient, glow, or decorative second palette.

Alpha icons preserve Stable icon geometry and transparency. Large frames at 48 px and above carry a
high-contrast ALPHA badge; 16/24/32 px ICO frames use a separately rendered A. Generate the assets
deterministically from the committed Stable source art and never overwrite Stable or Beta assets.

Only brand/primary/active chrome changes to purple. Semantic success remains teal; warnings remain
yellow/orange; destructive/error states remain red; scientific plot palettes, persisted series
colors, thumbnails, and exports remain unchanged.

## 6. Locked application behavior

### 6.1 Alpha owns its first-launch library decision

**Amended 2026-08-27 by explicit user decision.** The original rule — Alpha never copies from
another product and the Beta bootstrap flow is not reused — is superseded by this section. Children
053.1 and 053.2 were implemented under the original rule and remain correct; Child 053.3 introduces
the amended behavior.

Alpha lives entirely in its own `.cellxplorer-alpha` root unless `CELLXPLORER_DATA` explicitly
points elsewhere. On first launch, Alpha shows a blocking setup choice of exactly three options:

1. start with an empty Alpha library;
2. copy a one-time snapshot of the Stable library;
3. copy a one-time snapshot of the Beta library.

Locked rules for that copy:

- it is one-time, explicit, and user-initiated; copying is never automatic;
- exactly one source may be chosen, and only from Stable or Beta;
- the copy carries the user's Cells and their ordered SourceFiles, Analyses and saved plots,
  Folders/Projects, replicate groups, and app-managed `imports/` payload;
- the source product's database, imports, and profile root are opened read-only and are never
  modified, moved, or deleted;
- the copied library becomes Alpha-local immediately: new database instance UUID, Alpha-local
  managed import paths, Alpha-local caches regenerated normally;
- there is no ongoing synchronization, mirroring, or write-back in either direction afterwards;
- if a source is absent, corrupt, or schema-incompatible, that option is disabled with a reason and
  the remaining options stay available;
- `Start empty` is always available;
- after any choice, a durable Alpha-local marker records it and the prompt never appears again.

Alpha must reuse the verified Beta bootstrap machinery by generalizing it over the source channel.
Do not fork a parallel copy of the staging, activation, or verification code.

### 6.2 No cross-product installer coordinator

Stable retains its existing explicit first-Beta installation feature. Beta retains its bootstrap
behavior, unchanged. Alpha's own first-launch setup flow (§6.1, Child 053.3) is Alpha-local and is
not an installer coordinator: it never installs, launches, updates, or registers another product.
Alpha must not:

- show Stable's Beta opt-in/install controls;
- run Beta bootstrap checks or render Beta bootstrap UI;
- expose an “Install Alpha” command inside Stable or Beta;
- inspect another product's uninstall key to manage that product;
- transition from Alpha to Beta or Stable through the standard updater.

Alpha is installed from its own verified installer and thereafter updates itself from its own feed.

### 6.3 Fail-closed channel selection

All current two-value decisions must become explicit three-value decisions. Avoid binary
“Beta else Stable” logic that would silently classify Alpha as Stable.

Frontend, Python, Rust, build scripts, configuration resolution, updater validation, and release
automation must accept exactly stable, beta, or alpha and reject every other non-empty value.

## 7. Locked release/version contract

- Stable release versions remain exact X.Y.Z.
- Existing Beta dotted and legacy compact compatibility remains unchanged.
- Alpha releases accept only exact X.Y.Z-alpha.N and tags vX.Y.Z-alpha.N.
- Alpha has no compact legacy spelling.
- Build metadata and other prerelease labels are rejected.
- An Alpha release core must be strictly greater than the highest published exact Stable core.
- No ordering gate is imposed between Alpha and Beta. They are separate opt-in feeds and may target
  the same future Stable core.
- Alpha GitHub releases are prereleases and never become GitHub's normal latest release.
- Published release assets and channel pointers are immutable; corrections use a new version.

The first Alpha pointer is created only after its draft release, installer, signature, notes, and
manifest have passed the existing verification model.

## 8. Locked release-channels branch transition

The orphan release-channels branch remains manifest-only and must never be initialized from main.

Before the first published Alpha release, its valid tree is:

    README.md
    stable/latest.json
    beta/latest.json

After the first published Alpha release, its exact tree is:

    README.md
    stable/latest.json
    beta/latest.json
    alpha/latest.json

Alpha absence is a bootstrap state only when GitHub has no published Alpha release. Once any Alpha
release is published, a missing alpha/latest.json is always an error.

Publication must snapshot every existing non-target pointer, update only the selected pointer with
optimistic SHA protection, verify exact bytes through the Contents API and public raw endpoint, and
prove every non-target blob is unchanged. The current one-“other channel” workflow must therefore
be generalized to a set of non-target channels.

If first-Alpha pointer publication fails after the verified draft is made public, do not replace the
release assets. Repair only the manifest branch with optimistic protection and re-run exact
verification.

## 9. Current architecture that must be extended

Read and verify these anchors before implementation:

### Runtime identity and data

- frontend/src/appChannel.ts
- frontend/src/main.tsx
- frontend/src/App.tsx
- backend/app/services/app_channel.py
- src-tauri/src/app_channel.rs
- src-tauri/src/main.rs
- backend/app/services/portable_analysis.py
- frontend/src/components/BetaBootstrapCoordinator.tsx
- frontend/src/components/BetaInstallCoordinator.tsx

### Packaging

- src-tauri/tauri.conf.json
- src-tauri/tauri.beta.conf.json
- src-tauri/cellxplorer-installer.nsi
- src-tauri/nsis-hooks.nsh
- scripts/build-app.ps1
- scripts/build_frontend_channel.py
- scripts/frontend_channel.py
- scripts/build_beta_icons.py
- package.json

### Updates and releases

- src-tauri/src/app_updates.rs
- scripts/release_tag.py
- scripts/release_channel_policy.py
- scripts/release_channels.py
- scripts/verify_updater_manifest.py
- .github/workflows/release.yml
- tests/test_release_tag_script.py
- tests/test_release_workflow.py
- tests/test_updater_configuration.py

The current Stable/Beta modules, shared updater state machine, sidecar, NSIS template, and release
verification are foundations to extend, not replace.

## 10. Child sequence and ownership

### 053.1 — Alpha application identity, isolation, and packaging

Owns:

- exhaustive three-channel runtime model;
- Alpha frontend branding and Beta-only capability separation;
- Alpha Tauri overlay, Rust identity, data root, deep link, icon, frame, NSIS constants, and build;
- local policy/configuration/package tests;
- build-only and side-by-side identity evidence.

It does not change publishable tags or write any public channel pointer.

### 053.2 — Alpha updater, release publication, and closure

Depends on a clean 053.1 review. Owns:

- Alpha runtime version acceptance and updater endpoint verification;
- release tags and future-Stable policy;
- manifest verifier and release-channel tree transition;
- three-channel GitHub release workflow and target-only pointer protection;
- release/packaging documentation;
- final automated, build-only, and disposable installed/update matrix.

It must not push a production tag or publish a release without a separate explicit user instruction.

### 053.3 — Alpha first-launch database bootstrap

Added by the 2026-08-27 user amendment; depends on a clean 053.2 review. Owns:

- the channel-generalized bootstrap service, staging, activation, and marker model;
- Alpha's three-choice first-launch setup surface and its per-source availability reasons;
- Stable-source and Beta-source snapshot, managed-import rewrite, and read-only source guarantees;
- Alpha-local install-instance acknowledgement;
- focused tests for both sources plus unchanged Beta bootstrap behavior;
- documentation of the amended §6.1 model.

It must not change Beta's released bootstrap behavior, marker filenames, or endpoints, and must not
introduce any ongoing cross-product synchronization.

## 11. Parent-level verification

The final child must run and record:

    node --test frontend\tests\*.test.ts
    python -m unittest tests.test_app_channels tests.test_updater_configuration -v
    python -m unittest tests.test_release_tag_script tests.test_release_workflow -v
    cargo test --manifest-path src-tauri\Cargo.toml
    cargo check --manifest-path src-tauri\Cargo.toml
    python scripts\check_versions.py
    python scripts\preflight.py --no-cache

Build-only verification must produce Stable, Beta, and Alpha artifacts from the same reviewed commit
and verify each channel stamp, resolved Tauri identity, installer name, icon inputs, and updater
endpoint.

Manual browser and installed-Windows checks must be recorded truthfully as RUN or NOT RUN. They are
not implied by automated tests.

## 12. Parent acceptance

- [ ] All children are implemented sequentially and review-clean.
- [ ] Stable and Beta contracts remain backward compatible.
- [ ] Alpha is a distinct installed Windows product with the locked identity matrix.
- [ ] Alpha uses only .cellxplorer-alpha by default and never starts Beta's bootstrap flow.
- [ ] Alpha's own first-launch setup offers exactly start-empty, copy-Stable, and copy-Beta,
      leaves both source products untouched, and establishes no ongoing synchronization.
- [ ] Stable, Beta, and Alpha can run simultaneously and retain channel-local single-instance behavior.
- [ ] Deep links, autostart values, shortcuts, uninstall keys, and install directories do not collide.
- [ ] Alpha uses the locked purple theme, icon treatment, native frame, installer color, and ALPHA badge.
- [ ] Semantic and scientific colors remain channel-neutral.
- [ ] Alpha self-updates only from alpha/latest.json and rejects Stable/Beta versions.
- [ ] Stable and Beta continue to self-update only from their existing feeds.
- [ ] Alpha tags, manifests, assets, and GitHub prerelease state are validated exactly.
- [ ] First-Alpha branch bootstrap and post-bootstrap exact-tree rules are tested.
- [ ] Publication protects every non-target pointer, not only one “other” pointer.
- [ ] The complete three-product disposable install/update/uninstall matrix is recorded.
- [ ] Canonical no-cache preflight passes on the final branch.
- [ ] No database migration, CALC_VERSION change, scientific result change, or copied app tree is introduced.
- [ ] No production tag or release is created without explicit user authorization.

## 13. Out of scope

- separate repository, frontend tree, backend package, Rust crate, or NSIS template;
- ongoing Stable/Beta-to-Alpha synchronization, mirroring, or write-back of any kind
  (the one-time explicit first-launch copy is in scope under the amended §6.1);
- Alpha-to-Stable or Alpha-to-Beta copying in any direction;
- Alpha installation offered from Stable or Beta;
- automatic promotion between Alpha, Beta, and Stable;
- canary/nightly channels;
- macOS/Linux channel products;
- Windows Authenticode;
- updater signing-key rotation;
- schema migrations, parser changes, CALC_VERSION changes, or scientific behavior;
- changing existing Beta bootstrap semantics;
- publishing the first Alpha release during implementation.

## 14. Parent handoff

Implement only the active numeric child selected by the Spec 053 workflow. Children 053.1 and
053.2 predate the 2026-08-27 amendment and must not be reopened by it.

Read this parent first, then the active child in full. Also read AGENTS.md,
docs/specs/README.md, docs/specs/workflow/README.md, docs/agent-knowledge/README.md,
docs/agent-knowledge/architecture.md, docs/agent-knowledge/change-playbooks.md,
docs/agent-knowledge/visual-style-guide.md, docs/windows-packaging.md, and
docs/tauri-packaging-lessons.md.

Preserve the locked identity, color, isolation, version, and release-channel decisions above.
Do not implement a later child, initialize or alter the release-channels branch, tag, or publish
unless the active child and explicit user instruction authorize that exact action.
