# Parser and Capacity Preview Findings

Date: 2026-07-05

## Current Capacity Preview

The import preview currently parses the full Neware file through `NewareNDA.read(...)`, normalizes the raw time-series columns, then collapses the raw rows with `calc.per_cycle(...)`.

For each cycle, the app currently uses:

```python
discharge_capacity_mah = max(discharge_capacity_mah within the cycle)
```

It does not take the last row of the cycle.

This matters because the last row of a cycle is often a rest or charge row where `Discharge_Capacity(mAh)` may be zero. In the two sample `.ndax` files, using the last row of the whole cycle would be wrong for most or all cycles.

Using the last discharge row is closer, but it can still differ from the maximum in files that contain multiple discharge-like segments, partial diagnostic steps, or unusual cycle structure. The maximum is currently the most robust simple proxy for final achieved discharge capacity per cycle.

## Units

The parser exposes Neware capacity columns named `Charge_Capacity(mAh)` and `Discharge_Capacity(mAh)`. The app renames these to `charge_capacity_mah` and `discharge_capacity_mah` without applying another conversion. The preview label `mAh` matches the parser output.

## Supported Neware source dispatch

The supported source policy is `.nda`, `.ndax`, and structured Neware `.xlsx` only. The shared
dispatch and parser-bundle identity live in `backend/app/services/parsing.py`; the Excel mapping
itself lives in `backend/app/services/neware_excel.py` and produces the same canonical raw columns
used by the binary parser. Excel metadata inspection is bounded to the workbook's metadata and
protocol surfaces, while the `record` sheet remains the source of truth for point-level data.
Optional `step` and `cycle` sheets are independent validation summaries. Some exports do not carry
Neware semantic condition expressions, so protocol reconstruction must preserve that absence and
Chargeability must report no applicable match rather than infer one from the curve.

## How `.ndax` Is Parsed

The installed `NewareNDA` parser treats `.ndax` files as zip containers. It reads `data.ndc`, and for some formats also reads `data_runInfo.ndc` and `data_step.ndc`, then merges the resulting tables by `Index` or `Step`.

The current parser builds full pandas DataFrames before the app computes per-cycle values. This is convenient and reliable, but it means preview generation currently pays the cost of a full parse.

## Faster Preview Possibility

A faster preview path is possible, but it would require a specialized parser.

The likely approach would be a preview-only scanner that reads the relevant NDC binary records, unpacks only the fields needed for cycle capacity, and tracks `max(discharge_capacity)` per cycle without constructing the full raw DataFrame. This would still scan the relevant data stream once, but it would skip most columns, auxiliary channels, DataFrame construction, and plotting-only irrelevant data.

For `.ndax` files where capacity/cycle/status information is split across multiple `.ndc` files, this would need format-specific handling and possibly a lightweight merge by `Index` or `Step`.

There does not appear to be an existing cycle-end byte-offset index exposed by the installed parser or obvious metadata saying where each cycle capacity endpoint lives. Also, because `.ndax` stores `.ndc` files inside a compressed zip container, true random access into compressed members is not straightforward unless the member is first decompressed.

## Practical Recommendation

For now, keep the full parser for correctness. Later, optimize in this order:

1. Cache parsed raw/per-cycle data after the first import or preview.
2. Reuse cached per-cycle data for plots and library views.
3. Add a preview-only scanner only if full parsing remains too slow for large files.
