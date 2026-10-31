/** Generate/verify an exact, licensed subset of the pinned Tabler React modules. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'frontend/package.json'))) throw Error('Expected CellXplorer source tree');
const require = createRequire(import.meta.url);
const ts = require(path.join(root, 'frontend/node_modules/typescript'));
const vendor = path.join(root, 'frontend/vendor/tabler-icons-react');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : /\.(ts|tsx|mts)$/.test(entry.name) ? [target] : [];
  });
}
function importsUsed() {
  const imports = new Set();
  for (const file of [...sourceFiles(path.join(root, 'frontend/src')), ...sourceFiles(path.join(root, 'frontend/tests'))]) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function audit(node) {
      if (ts.isStringLiteral(node) && node.text.startsWith('@tabler/icons-react')) {
        const parent = node.parent;
        const reference = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) ||
          (ts.isCallExpression(parent) && (parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')));
        if (reference && !(ts.isImportDeclaration(parent) && node.text === '@tabler/icons-react')) {
          throw Error('Unsupported Tabler reference; do not silently omit icons: '+file);
        }
      }
      ts.forEachChild(node, audit);
    }
    audit(source);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== '@tabler/icons-react') continue;
      const clause = node.importClause;
      if (clause?.name || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) throw Error('Only explicit named Tabler imports are supported: '+file);
      for (const symbol of clause.namedBindings.elements) imports.add((symbol.propertyName ?? symbol.name).text);
    }
  }
  return [...imports].sort();
}
const names = importsUsed();
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'subset.json')));
  if (JSON.stringify(names) !== JSON.stringify(manifest.imports)) throw Error('Tabler imports changed; regenerate the subset from the pinned upstream package');
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (sha(fs.readFileSync(path.join(vendor, name))) !== hash) throw Error('Subset integrity mismatch: '+name);
  }
  if (manifest.render_reference_sha256 && sha(fs.readFileSync(path.join(vendor, 'render-reference.json'))) !== manifest.render_reference_sha256) throw Error('Upstream render reference integrity mismatch');
  console.log(JSON.stringify({ verified: true, imports: names.length, files: Object.keys(manifest.files).length }));
  process.exit(0);
}
const upstream = path.resolve(process.argv[2] ?? path.join(root, 'frontend/node_modules/@tabler/icons-react'));
const upstreamMeta = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json')));
if (upstreamMeta.version !== '3.44.0' || upstreamMeta.name !== '@tabler/icons-react') throw Error('Expected pinned upstream @tabler/icons-react 3.44.0');
if (fs.existsSync(vendor)) throw Error('Never overwrite an existing subset; verify it with --check');
const upstreamEsm = path.join(upstream, 'dist/esm');
const barrel = fs.readFileSync(path.join(upstreamEsm, 'tabler-icons-react.mjs'), 'utf8');
const exportsMap = new Map();
for (const match of barrel.matchAll(/export \{ (.*?) \} from '(\.\/icons\/[^']+)';/g)) {
  for (const symbol of match[1].split(', ')) {
    const alias = /^default as (\w+)$/.exec(symbol);
    if (alias) exportsMap.set(alias[1], match[2]);
  }
}
const typeNames = new Set(['Icon', 'IconProps', 'IconNode', 'TablerIcon']);
const icons = names.filter(name => !typeNames.has(name));
for (const name of icons) if (!exportsMap.has(name)) throw Error('Missing upstream icon '+name);
const files = {};
const sourceHashes = {};
function write(name, bytes) {
  const target = path.join(vendor, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  files[name] = sha(bytes);
}
function copy(source, destination) {
  const bytes = fs.readFileSync(source);
  sourceHashes[path.relative(upstream, source).replaceAll('\\', '/')] = sha(bytes);
  write(destination, bytes);
}
copy(path.join(upstream, 'LICENSE'), 'LICENSE');
for (const name of ['createReactComponent.mjs', 'defaultAttributes.mjs']) copy(path.join(upstreamEsm, name), 'dist/'+name);
for (const module of new Set(icons.map(name => exportsMap.get(name)))) copy(path.join(upstreamEsm, module), 'dist/'+module.slice(2));
write('dist/index.mjs', icons.map(name => `export { default as ${name} } from '${exportsMap.get(name)}';`).join('\n')+'\n');
const dts = fs.readFileSync(path.join(upstream, 'dist/tabler-icons-react.d.ts'), 'utf8');
const preamble = dts.slice(0, dts.indexOf('/**'));
const declarations = icons.map(name => {
  const declaration = dts.match(new RegExp(`declare const ${name}: [^;]+;`));
  // Aliases in the JS barrel have the exact same component type.
  return declaration?.[0] ?? `declare const ${name}: react.ForwardRefExoticComponent<IconProps & react.RefAttributes<SVGSVGElement>>;`;
});
write('dist/index.d.ts', preamble+declarations.join('\n')+'\nexport { '+[...typeNames, ...icons].join(', ')+' };\n');
write('package.json', JSON.stringify({ name: '@tabler/icons-react', version: '3.44.0-cellxplorer.1',
  private: true, type: 'module', license: 'MIT', sideEffects: false,
  main: './dist/index.mjs', module: './dist/index.mjs', types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs', default: './dist/index.mjs' } },
  files: ['dist', 'LICENSE', 'subset.json'], peerDependencies: { react: '>=16' } }, null, 2)+'\n');
fs.writeFileSync(path.join(vendor, 'subset.json'), JSON.stringify({ upstream: '@tabler/icons-react', version: upstreamMeta.version,
  imports: names, files, upstream_sha256: sourceHashes, generator: 'scripts/tabler_subset.mjs' }, null, 2)+'\n');
console.log(JSON.stringify({ imports: names.length, icons: icons.length, files: Object.keys(files).length, destination: vendor }));
