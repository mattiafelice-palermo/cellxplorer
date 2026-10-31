import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend/package.json'));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const subset = await import('../frontend/vendor/tabler-icons-react/dist/index.mjs');
const fixture = path.join(root, 'frontend/vendor/tabler-icons-react/render-reference.json');
const variants = [{}, {size:19, stroke:1.25, color:'#a12345', className:'custom', title:'Accessible title', 'aria-label':'fixture'},
  {size:'1em', stroke:3, children:React.createElement('circle',{key:'fixture-child',cx:12,cy:12,r:1})}];
if (process.argv.includes('--capture-upstream')) {
  if (fs.existsSync(fixture)) throw Error('Reference must never be overwritten');
  const upstreamMetadata = JSON.parse(fs.readFileSync(path.join(root, 'frontend/node_modules/@tabler/icons-react/package.json')));
  assert.equal(upstreamMetadata.version, '3.44.0', 'Reference must come from the original pinned upstream package, never the subset');
  const upstream = require('@tabler/icons-react');
  const reference = {};
  for (const name of Object.keys(subset).sort()) {
    reference[name] = variants.map(props => renderToStaticMarkup(React.createElement(upstream[name],props)));
  }
  fs.writeFileSync(fixture,JSON.stringify(reference,null,2)+'\n');
  const manifestPath = path.join(root,'frontend/vendor/tabler-icons-react/subset.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.render_reference_sha256 = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
}
const reference = JSON.parse(fs.readFileSync(fixture));
const manifestPath = path.join(root,'frontend/vendor/tabler-icons-react/subset.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
const referenceHash = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
assert.ok(manifest.render_reference_sha256, 'Capture and seal the reference from the pinned upstream package first');
assert.equal(manifest.render_reference_sha256,referenceHash,'Upstream reference hash');
assert.deepEqual(Object.keys(subset).sort(), Object.keys(reference).sort());
for (const [name, expected] of Object.entries(reference)) {
  assert.deepEqual(variants.map(props => renderToStaticMarkup(React.createElement(subset[name],props))), expected, name);
}
console.log(JSON.stringify({icons:Object.keys(reference).length, render_comparisons:Object.keys(reference).length*variants.length, passed:true}));
