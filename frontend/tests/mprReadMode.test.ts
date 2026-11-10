import assert from "node:assert/strict";
import test from "node:test";
import { mprReadModeForPath, withMprReadMode, inspectPathsWithReadModes } from "../src/mprReadMode.ts";
import { importPreviewQueryKey, importPreviewRequest } from "../src/importPreviewPolicy.ts";
import type { ImportPreview } from "../src/api.ts";
import { mprWarningExample } from "../src/mprWarningExample.ts";

const modes = { "c:\\data\\a.mpr": "permissive" as const, "c:\\data\\b.ndax": "permissive" as const };

test("mode is per source, path-alias stable, and MPR only", () => {
  assert.equal(mprReadModeForPath("C:/DATA/a.MPR", modes), "permissive");
  assert.equal(mprReadModeForPath("C:/data/b.ndax", modes), "safe");
  assert.equal(mprReadModeForPath("C:/data/c.mpr", modes), "permissive");
  assert.equal(mprReadModeForPath("C:/data/c.mpr", { "c:\\data\\c.mpr": "safe" }), "safe");
  const file = { path: "C:/data/a.mpr", name: "a.mpr", kind: "file" as const, size: 1, modified_at: null };
  assert.equal(withMprReadMode(file, modes).read_mode, "permissive");
  assert.equal(file.read_mode, undefined);
});

test("mixed selection inspects explicit modes and preserves the original order", async () => {
  const paths = ["C:/data/a.mpr", "C:/data/c.mpr", "C:/data/b.ndax"];
  const calls: unknown[] = [];
  const result = await inspectPathsWithReadModes(paths, modes, async (group, mode) => {
    calls.push([group, mode]);
    return { files: group.map((path) => ({ source_path: path, read_mode: mode }) as ImportPreview), failures: [] };
  });
  assert.deepEqual(calls, [[[paths[2]], "safe"], [[paths[0], paths[1]], "permissive"]]);
  assert.deepEqual(result.files.map((file) => file.source_path), paths);
  assert.deepEqual(result.files.map((file) => file.read_mode), ["permissive", "permissive", "safe"]);
});

test("capacity preview cache and fingerprint request retain selected mode", () => {
  assert.notDeepEqual(importPreviewQueryKey("abc", "safe"), importPreviewQueryKey("abc", "permissive"));
  const draft = { staged_name: "a.mpr", source_path: "C:/a.mpr", hash: "abc", size: 10, inspection: { hash: "abc", size: 10, mtime_ns: 7, read_mode: "permissive" as const }, read_mode: "permissive" as const };
  assert.equal(importPreviewRequest(draft).read_mode, "permissive");
});

test("exploratory diagnostics show original instrument-error positions and interpretation reasons", () => {
  assert.equal(mprWarningExample({ record_index: 40674 }), "Original record 40674.");
  assert.equal(mprWarningExample({ reason: "Acquisition clock moves backward" }), "Acquisition clock moves backward");
  assert.equal(mprWarningExample({ record_index: 4, reason: "Instrument error" }), "Original record 4: Instrument error");
  assert.equal(mprWarningExample({ cycle: 1 }), null);
});


test("figure notice persists in export layout without changing scientific traces or other annotations", async () => {
  const { withMprReadNotice } = await import("../src/features/analyses/editor/plotting/mprReadNotice.ts");
  const layout = { margin: { t: 20, l: 70 }, annotations: [{ text: "Reference", x: 1, y: 1 }] };
  assert.equal(withMprReadNotice(layout, []), layout);
  const marked = withMprReadNotice(layout, [{ kind: "exploratory_mpr", detail: "Source interpretation uncertain" }]);
  assert.equal(marked.annotations?.length, 2);
  assert.equal(marked.annotations?.[0].text, "Reference");
  assert.match(marked.annotations?.[1].text ?? "", /unverified cycle identity/);
  assert.equal(marked.margin?.t, 40);
  assert.equal(layout.annotations.length, 1);
});
