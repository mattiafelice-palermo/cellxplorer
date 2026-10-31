import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../..', import.meta.url));
test('Tabler subset matches imports, hashes and upstream SVG render fixtures', () => {
  for (const args of [['scripts/tabler_subset.mjs', '--check'], ['scripts/verify_tabler_subset.mjs']]) {
    const result = execFileSync(process.execPath, args, {cwd:root, encoding:'utf8'});
    assert.match(result, /true/);
  }
});
