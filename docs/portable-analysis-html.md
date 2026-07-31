# Portable analysis HTML

CellXplorer exports an analysis as one HTML file. The file is both a standalone browser report and
a versioned package that CellXplorer can import without executing its JavaScript.

## Export modes

New exports use format version 2 and offer two modes:

- **Linked report:** embeds frozen Plotly figures, metadata, analysis settings, source paths and
  checksums. Import reconnects existing library sources by checksum or verifies the recorded path.
- **Self-contained report:** adds the original `.nda`/`.ndax` sources. Sources are gzip-compressed
  before Base64 encoding and parsed into local caches after import.

Parquet caches are internal, regenerable application data and are not included in version 2
exports. Version 1 packages containing caches remain importable.

The export dialog lets the user include any subset of the analysis's saved plots. Metadata,
analysis settings and source references remain part of the package so it can still be imported.

The scientific package shape is `Cell -> ordered sources`. Each Cell records its sources in the
canonical `TestFile.position` order, with an explicit position and tracked-tail marker; Test names,
groups, and per-Test lifecycle state are not portable product data. Cell order, the global source
document list, and embedded payload order are all derived from the same deterministic selection
order.

## Original-source preflight

When original files are requested, export hashes every selected `.nda`/`.ndax` source before it
generates plot snapshots. A source is ready only when its current bytes match the checksum stored
by CellXplorer and its size and modification time remain stable throughout the check.

If a checksum changed, export pauses and offers two explicit choices:

- adopt the stable file version, rebuild its scientific cache, invalidate every dependent
  analysis, regenerate the selected plots, and export with the matching originals;
- export the report without any original files.

Unavailable, unreadable, or still-growing sources cannot be adopted until they become stable, but
the report-only option remains available. The final packaging pass checks each embedded payload
against the stored checksum again. If a file changes after preflight, the sources-included export
fails instead of silently omitting that file.

## Plot snapshots

The frontend generates each saved view with the same trace and layout functions used by the
analysis editor. The report stores that serialized Plotly figure and embeds one compressed offline
Plotly runtime. This preserves subplots, secondary axes, bands, colors, markers, ranges, frames,
legends, hover and zoom behavior.

Some document previews, including Microsoft Teams, execute report JavaScript but block a Blob URL
used to load the embedded Plotly runtime. The report therefore builds its navigation, metadata,
downloads and CSV export before attempting Plotly. Every exported view also carries a sanitized,
pre-rendered Plotly SVG generated from the same final figure. If Plotly is blocked, that faithful
SVG is shown instead; opening the same file in a normal browser restores the complete interactive
figure.

CSV export is generated directly from the plotted traces, avoiding a second copy of the numerical
arrays. Repeated per-segment hover labels are stored once as Plotly trace metadata, and
dispersion-band helper traces are excluded from CSV.

## Container

The HTML contains:

1. The report shell, CSS and loader JavaScript.
2. A JSON manifest in `cellxplorer-manifest`.
3. Independently gzip-compressed, Base64-encoded payloads.

Version 2 payload kinds are:

- `report`
- `plotly_runtime`
- `original_source` when requested and available

Each descriptor records its content type, compressed and uncompressed size, and SHA-256 checksum.
Original files and the Plotly runtime are decoded only when needed.

When original sources are embedded, a header action opens a source-download dialog. The reader can
download files individually or download one ZIP. Every cell gets its own folder in the ZIP and all
source files belonging to that cell are placed inside it, which also supports future multi-file
cells without flattening their provenance.

Files inside each Cell folder retain the recorded source order. A source is never flattened into a
combined file and a continued Cell is never split into multiple portable Cells.

## Import

CellXplorer treats the HTML as an untrusted container:

- embedded report JavaScript is never executed during import;
- every decoded payload is checked against its declared size and SHA-256;
- unsupported future format or analysis-spec versions are rejected;
- IDs are remapped and names are disambiguated instead of overwriting local records.

Import first stages and inspects the package without changing the database. The review shows every
cell and classifies its sources as:

- an exact checksum match that will reuse the library cell;
- a new source that will be added to the library;
- a possible updated/older version, based on filename and matching test metadata.

Possible versions with different checksums always require an explicit choice between using a
matching library cell or keeping the package version as a separate cell. Cycle count, row count and
file size are used only to suggest which appears newer; they never silently establish identity.

For a multi-source Cell, reuse requires the complete ordered source-hash chain to match. The same
hashes in a different order, or a partial overlap with another Cell, is a conflict and is rejected
before the import transaction commits. A newly imported Cell receives exactly one internal Test
row with its ordered source links. The untrusted decoder validates non-empty source chains, exact
dense positions, unique known source references, and the single final tracked tail before source
resolution or database writes. Older packages with nested Test envelopes remain readable only when
they contain exactly one envelope with a non-empty, unique ordered source list; ambiguous or
malformed chains are rejected rather than flattened or normalized.

On confirmation the user can rename the analysis, create or select its folder, and optionally add
references to all imported/reused cells in that folder. The import then runs as one database
transaction.

For each accepted package source, import tries:

1. an existing database source with the same checksum;
2. the recorded original path, verified by checksum;
3. an embedded original source.

An available source is parsed into normal local caches. If no source is available, the imported
cell and analysis remain registered but offline until the user relinks the file. The standalone
HTML remains fully viewable regardless.

## Size

Plotly itself is embedded once and compresses strongly. Neware binaries are also gzip-compressed,
but many `.ndax` files are already dense and may shrink only slightly; Base64 adds roughly 33% to
the compressed payload size.
