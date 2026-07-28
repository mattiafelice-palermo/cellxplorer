#!/usr/bin/env python3
"""Apply the reviewed post-release Beta fixes on the ad hoc feature branch."""

from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}: found {count}\n{old[:160]}")
    path.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


def replace_all(path: Path, old: str, new: str, minimum: int = 1) -> int:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count < minimum:
        raise RuntimeError(f"Expected at least {minimum} matches in {path}: found {count}: {old}")
    path.write_text(text.replace(old, new), encoding="utf-8", newline="\n")
    return count


def patch_relaunch() -> None:
    path = ROOT / "src-tauri" / "src" / "main.rs"
    old = '''/// Schedule a fresh process to start after this one has exited far enough to
/// release `tauri_plugin_single_instance`'s lock. `AppHandle::restart()` spawns
/// *before* exit, so the replacement can see the lock, hand off to the dying
/// instance, and exit — leaving no app and no backend.
fn schedule_relaunch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // PowerShell quoting: double any single quotes inside the path.
        let exe_arg = exe.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Start-Sleep -Seconds 1; Start-Process -FilePath '{}'",
            exe_arg
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            // CREATE_NO_WINDOW — same flag used by stop_backend's taskkill.
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| format!("could not schedule relaunch: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 1; exec '{}'", exe.display()))
            .spawn()
            .map_err(|error| format!("could not schedule relaunch: {error}"))?;
        Ok(())
    }
}
'''
    new = '''const RELAUNCH_AFTER_PID_ARG: &str = "--relaunch-after-pid";

fn parse_relaunch_parent_pid(args: impl IntoIterator<Item = String>) -> Result<Option<u32>, String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg != RELAUNCH_AFTER_PID_ARG {
            continue;
        }
        let raw = args
            .next()
            .ok_or_else(|| "Relaunch parent PID is missing.".to_string())?;
        let pid = raw
            .parse::<u32>()
            .map_err(|_| "Relaunch parent PID is invalid.".to_string())?;
        return Ok(Some(pid));
    }
    Ok(None)
}

#[cfg(target_os = "windows")]
fn windows_process_is_running(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let filter = format!("PID eq {pid}");
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .creation_flags(0x08000000)
        .output();
    let Ok(output) = output else {
        return true;
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    output.status.success() && stdout.contains(&format!("\"{pid}\""))
}

/// Helper mode runs before Tauri and therefore before the single-instance
/// plugin. It waits for the exact parent process to disappear, then starts a
/// clean ordinary process. This removes the fixed-delay race that could leave
/// Beta closed after applying the copied library.
fn run_relaunch_helper_if_requested() -> Result<bool, String> {
    let Some(parent_pid) = parse_relaunch_parent_pid(std::env::args().skip(1))? else {
        return Ok(false);
    };

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        for _ in 0..300 {
            if !windows_process_is_running(parent_pid) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if windows_process_is_running(parent_pid) {
            return Err("The previous CellXplorer process did not exit in time.".to_string());
        }
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        std::process::Command::new(exe)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|error| format!("could not launch the replacement process: {error}"))?;
        return Ok(true);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = parent_pid;
        thread::sleep(Duration::from_secs(1));
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        std::process::Command::new(exe)
            .spawn()
            .map_err(|error| format!("could not launch the replacement process: {error}"))?;
        Ok(true)
    }
}

/// Schedule a helper copy of this executable before stopping the backend. The
/// helper itself does not initialize Tauri; it waits for this exact PID to exit
/// and only then launches the replacement application.
fn schedule_relaunch() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let parent_pid = std::process::id().to_string();
    let mut command = std::process::Command::new(exe);
    command.args([RELAUNCH_AFTER_PID_ARG, &parent_pid]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not schedule relaunch: {error}"))
}
'''
    replace_once(path, old, new)
    replace_once(
        path,
        '''fn main() {
    let context = tauri::generate_context!();''',
        '''fn main() {
    match run_relaunch_helper_if_requested() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("CellXplorer relaunch helper failed: {error}");
            return;
        }
    }

    let context = tauri::generate_context!();''',
    )
    replace_once(
        path,
        '''    #[test]
    fn beta_and_standard_pending_revisions_are_independent() {''',
        '''    #[test]
    fn relaunch_parent_pid_parser_is_exact() {
        assert_eq!(
            parse_relaunch_parent_pid([
                "--hidden".to_string(),
                RELAUNCH_AFTER_PID_ARG.to_string(),
                "1234".to_string(),
            ])
            .unwrap(),
            Some(1234)
        );
        assert_eq!(parse_relaunch_parent_pid(["--hidden".to_string()]).unwrap(), None);
        assert!(parse_relaunch_parent_pid([RELAUNCH_AFTER_PID_ARG.to_string()]).is_err());
        assert!(parse_relaunch_parent_pid([
            RELAUNCH_AFTER_PID_ARG.to_string(),
            "not-a-pid".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn beta_and_standard_pending_revisions_are_independent() {''',
    )


def patch_installer() -> None:
    path = ROOT / "src-tauri" / "cellxplorer-installer.nsi"
    replace_once(
        path,
        '''!if "${BUNDLEID}" == "com.cellxplorer.desktop.beta"
  !define CX_PROFILE_DATA_DIR ".cellxplorer-beta"
!else
  !if "${BUNDLEID}" == "com.cellxplorer.desktop"
    !define CX_PROFILE_DATA_DIR ".cellxplorer"
  !else
    !error "Unsupported CellXplorer bundle identifier for profile data directory: ${BUNDLEID}"
  !endif
!endif''',
        '''!if "${BUNDLEID}" == "com.cellxplorer.desktop.beta"
  !define CX_PROFILE_DATA_DIR ".cellxplorer-beta"
  !define CX_BRAND_RGB "3678B7"
  ; Windows COLORREF: 0x00BBGGRR for #3678B7.
  !define CX_BRAND_COLORREF 0x00B77836
!else
  !if "${BUNDLEID}" == "com.cellxplorer.desktop"
    !define CX_PROFILE_DATA_DIR ".cellxplorer"
    !define CX_BRAND_RGB "12B886"
    ; Windows COLORREF: 0x00BBGGRR for #12B886.
    !define CX_BRAND_COLORREF 0x0086B812
  !else
    !error "Unsupported CellXplorer bundle identifier for profile data directory: ${BUNDLEID}"
  !endif
!endif''',
    )
    replace_all(path, '"12B886"', '"${CX_BRAND_RGB}"', minimum=8)
    replace_all(path, "0x0086B812", "${CX_BRAND_COLORREF}", minimum=1)
    replace_all(path, "filled teal", "filled channel-primary", minimum=1)
    replace_all(path, "teal flat progress bar", "channel-primary flat progress bar", minimum=1)


def patch_frontend() -> None:
    path = ROOT / "frontend" / "src" / "main.tsx"
    replace_once(
        path,
        '''        colors: { betaBlue: [...betaBlue] },
        primaryShade: { light: 7, dark: 6 },''',
        '''        // Beta must not leak Stable teal through legacy explicit `teal`
        // component props or CSS variables. Treat those legacy brand uses as
        // Beta blue until they are individually migrated to the primary color.
        colors: { betaBlue: [...betaBlue], teal: [...betaBlue] },
        primaryShade: { light: 7, dark: 6 },''',
    )

    path = ROOT / "frontend" / "src" / "components" / "AppUpdateModal.tsx"
    replace_once(
        path,
        '''import { IconDownload } from "@tabler/icons-react";

import {''',
        '''import { IconDownload } from "@tabler/icons-react";

import { APP_BRANDING } from "../appChannel";
import {''',
    )
    replace_all(path, 'color="teal"', 'color={APP_BRANDING.primaryColor}', minimum=6)

    path = ROOT / "frontend" / "src" / "components" / "BetaInstallModal.tsx"
    replace_all(path, 'color="teal"', 'color="betaBlue"', minimum=1)


def patch_icon_generator() -> None:
    path = ROOT / "scripts" / "build_beta_icons.py"
    path.write_text('''#!/usr/bin/env python3
"""Derive unmistakable multi-resolution Beta icon assets from Stable art."""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
STABLE_ICON = ROOT / "frontend" / "public" / "app-icon.png"
BETA_PUBLIC = ROOT / "frontend" / "public" / "app-icon-beta.png"
BETA_DIR = ROOT / "src-tauri" / "icons-beta"

BETA_RGB = (0x7D, 0xB7, 0xE8)
BADGE_RGB = (0x26, 0x54, 0x87)
STABLE_BRAND_ANCHORS = (
    (0x12, 0xB8, 0x86),
    (0x20, 0xC9, 0x97),
    (0x0C, 0xA6, 0x78),
    (0x63, 0xE6, 0xB7),
    (0x96, 0xF2, 0xD7),
)

PIXEL_FONT = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
}


def _distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _is_brand_teal(r: int, g: int, b: int, a: int) -> bool:
    if a < 16 or g <= r or g <= b:
        return False
    return min(_distance((r, g, b), anchor) for anchor in STABLE_BRAND_ANCHORS) <= 72


def recolor_icon(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if not _is_brand_teal(r, g, b, a):
                continue
            anchor = min(STABLE_BRAND_ANCHORS, key=lambda color: _distance((r, g, b), color))
            anchor_luma = sum(anchor) / 3
            scale = max(0.55, min(1.35, ((r + g + b) / 3) / anchor_luma))
            pixels[x, y] = tuple(max(0, min(255, int(value * scale))) for value in BETA_RGB) + (a,)
    return image


def _draw_pixel_text(draw: ImageDraw.ImageDraw, text: str, x: int, y: int, scale: int) -> None:
    cursor = x
    for letter in text:
        rows = PIXEL_FONT[letter]
        for row_index, row in enumerate(rows):
            for column_index, value in enumerate(row):
                if value == "1":
                    x0 = cursor + column_index * scale
                    y0 = y + row_index * scale
                    draw.rectangle((x0, y0, x0 + scale - 1, y0 + scale - 1), fill="white")
        cursor += 6 * scale


def render_size(base: Image.Image, size: int) -> Image.Image:
    image = base.resize((size, size), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(image)
    if size >= 128:
        scale = max(2, size // 64)
        text = "BETA"
        width = (len(text) * 6 - 1) * scale
        height = 7 * scale
        padding_x = 3 * scale
        padding_y = 2 * scale
        left = size - width - 2 * padding_x - max(3, size // 32)
        top = size - height - 2 * padding_y - max(3, size // 32)
        draw.rounded_rectangle(
            (left, top, size - max(3, size // 32), size - max(3, size // 32)),
            radius=max(2, size // 32),
            fill=BADGE_RGB + (255,),
        )
        _draw_pixel_text(draw, text, left + padding_x, top + padding_y, scale)
    else:
        scale = max(1, size // 16)
        width = 5 * scale
        height = 7 * scale
        padding = max(1, scale)
        right = size - 1
        bottom = size - 1
        left = right - width - 2 * padding
        top = bottom - height - 2 * padding
        draw.rectangle((left, top, right, bottom), fill=BADGE_RGB + (255,))
        _draw_pixel_text(draw, "B", left + padding, top + padding, scale)
    return image


def write_rgba(image: Image.Image, destination: Path) -> None:
    destination.write_bytes(image.convert("RGBA").tobytes())


def write_ico(base: Image.Image, destination: Path) -> None:
    sizes = [16, 24, 32, 48, 256]
    images = [render_size(base, size) for size in sizes]
    images[-1].save(
        destination,
        format="ICO",
        sizes=[(size, size) for size in sizes],
        append_images=images[:-1],
    )


def main() -> int:
    if not STABLE_ICON.is_file():
        print(f"Missing stable icon source: {STABLE_ICON}", file=sys.stderr)
        return 1
    base = recolor_icon(STABLE_ICON)
    beta_256 = render_size(base, 256)
    BETA_DIR.mkdir(parents=True, exist_ok=True)
    beta_256.save(BETA_PUBLIC, format="PNG")
    beta_256.save(BETA_DIR / "icon.png", format="PNG")
    write_rgba(beta_256, BETA_DIR / "icon-256.rgba")
    write_ico(base, BETA_DIR / "icon.ico")
    print("Wrote Beta icons with BETA/B size-specific badges")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
''', encoding="utf-8", newline="\n")

    test = ROOT / "tests" / "test_build_beta_icons.py"
    replace_once(
        test,
        '''    def test_beta_rgba_is_256_square(self):
        raw = (BETA_DIR / "icon-256.rgba").read_bytes()
        self.assertEqual(len(raw), 256 * 256 * 4)
''',
        '''    def test_beta_rgba_is_256_square(self):
        raw = (BETA_DIR / "icon-256.rgba").read_bytes()
        self.assertEqual(len(raw), 256 * 256 * 4)

    def test_beta_icon_has_visible_badge_at_large_and_small_sizes(self):
        try:
            from PIL import Image
        except ImportError as error:
            self.skipTest(f"Pillow is required for icon tests: {error}")

        badge = (0x26, 0x54, 0x87)
        with Image.open(BETA_PUBLIC).convert("RGBA") as icon:
            colors = {pixel[:3] for pixel in icon.getdata() if pixel[3] > 0}
            self.assertIn(badge, colors)
            self.assertIn((255, 255, 255), colors)

        import importlib.util
        spec = importlib.util.spec_from_file_location("build_beta_icons_probe", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        small = module.render_size(module.recolor_icon(STABLE_ICON), 16)
        small_colors = {pixel[:3] for pixel in small.getdata() if pixel[3] > 0}
        self.assertIn(badge, small_colors)
        self.assertIn((255, 255, 255), small_colors)
''',
    )


def patch_channel_tests() -> None:
    path = ROOT / "tests" / "test_app_channels.py"
    replace_once(
        path,
        '''    def test_nsis_destructive_uninstall_targets_channel_specific_data_root(self):''',
        '''    def test_nsis_branding_is_channel_specific(self):
        nsis = NSIS.read_text(encoding="utf-8")
        self.assertIn('!define CX_BRAND_RGB "3678B7"', nsis)
        self.assertIn('!define CX_BRAND_COLORREF 0x00B77836', nsis)
        self.assertIn('!define CX_BRAND_RGB "12B886"', nsis)
        self.assertIn('!define CX_BRAND_COLORREF 0x0086B812', nsis)
        self.assertGreaterEqual(nsis.count('${CX_BRAND_RGB}'), 8)
        self.assertIn('${CX_BRAND_COLORREF}', nsis)

    def test_nsis_destructive_uninstall_targets_channel_specific_data_root(self):''',
    )


def patch_docs() -> None:
    agents = ROOT / "AGENTS.md"
    replace_once(
        agents,
        '''By default all user state is under `%USERPROFILE%\\.cellxplorer`:

- `cellxplorer.db`: canonical SQLite database''',
        '''Stable user state defaults to `%USERPROFILE%\\.cellxplorer`; Beta user state defaults to
`%USERPROFILE%\\.cellxplorer-beta`. `CELLXPLORER_DATA` overrides either root exactly:

- `cellxplorer.db`: canonical SQLite database''',
    )

    architecture = ROOT / "docs" / "agent-knowledge" / "architecture.md"
    marker = '''Quick settings covers reload interface, desktop-only restart (`restart_app` in
`src-tauri/src/main.rs`: schedule a delayed relaunch, then `stop_backend` and `app.exit` —
never `AppHandle::restart()`, which races `tauri_plugin_single_instance`), Appearance'''
    replacement = '''Quick settings covers reload interface and desktop-only restart. Restart and Beta bootstrap use
an internal `--relaunch-after-pid <pid>` helper mode handled before Tauri/single-instance startup:
the helper waits for the exact parent process to exit, then starts a clean application process.
Never use a fixed sleep, PowerShell-only delayed launch, or `AppHandle::restart()`, all of which can
race `tauri_plugin_single_instance`. Appearance'''
    replace_once(architecture, marker, replacement)

    lessons = ROOT / "docs" / "tauri-packaging-lessons.md"
    insert = '''
## Restart and first-run bootstrap invariant

Desktop restart and Beta database-bootstrap apply use an internal
`--relaunch-after-pid <pid>` helper mode. The helper runs before Tauri and the single-instance plugin,
waits for the exact old PID to disappear, and only then starts the ordinary application. Do not
replace this with a fixed sleep, `AppHandle::restart()`, or an unverified PowerShell `Start-Process`;
all can launch while the old single-instance lock still exists and leave the app closed.

The Beta icon is not merely recoloured: 256 px assets carry a readable `BETA` badge and small ICO
frames carry a simplified `B`. Installer brand controls use channel constants selected from the
exact bundle identifier; literal Stable teal must not appear in a Beta installer.
'''
    text = lessons.read_text(encoding="utf-8")
    anchor = "## Codex sandbox frontend build issue"
    if anchor not in text:
        raise RuntimeError("Packaging lessons insertion anchor missing")
    lessons.write_text(text.replace(anchor, insert + "\n" + anchor, 1), encoding="utf-8", newline="\n")

    spec = ROOT / "docs" / "specs" / "021-stable-beta-app-identities.md"
    text = spec.read_text(encoding="utf-8")
    old = '''- do not add tiny text, a Greek beta symbol or another overlay that becomes unreadable at 16 px.'''
    new = '''- revised after installed Beta feedback: large icon frames show a high-contrast `BETA` badge;
- 16/24/32 px frames use a simplified high-contrast `B` badge rendered specifically at that size.'''
    if old not in text:
        raise RuntimeError("Spec 021 icon decision anchor missing")
    spec.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


def main() -> int:
    patch_relaunch()
    patch_installer()
    patch_frontend()
    patch_icon_generator()
    patch_channel_tests()
    patch_docs()
    subprocess.run(["python", "scripts/build_beta_icons.py"], cwd=ROOT, check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
