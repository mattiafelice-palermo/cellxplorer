# Spec 051 asset — BioLogic MPR column registry

This asset defines CellXplorer's project-owned working registry of BioLogic MPR data-column storage facts used by Spec 051.

The registry separates **binary storage facts** from **scientific interpretation**. A column may be known well enough to skip safely without being promoted into CellXplorer's canonical cycling model. Scientific meaning can also be technique-dependent even when storage width is stable.

## Registry rules

- `float64` means little-endian 64-bit IEEE floating point and occupies 8 bytes.
- `float32` means little-endian 32-bit IEEE floating point and occupies 4 bytes.
- `uint32` means little-endian unsigned 32-bit integer and occupies 4 bytes.
- `uint16` means little-endian unsigned 16-bit integer and occupies 2 bytes.
- `uint8` occupies 1 byte.
- Packed logical flag IDs are matched by their exact encoded ID and do not each consume a new byte. They share the physical packed flag byte.
- For ordinary data columns, CellXplorer preserves the full encoded ID but derives the storage-definition ID as `encoded_id % 256`.
- The resulting base ID is used only to resolve the registered storage dtype/width and working metadata. The full encoded ID remains available for diagnostics, provenance, and future semantic distinctions.
- A previously unseen full encoded ID does not make the file unsupported if its modulo-256 base ID exists in this registry: CellXplorer can determine the column's byte width and continue decoding safely.
- If the modulo-256 base ID is not registered and its byte width cannot otherwise be established safely, the parser must fail closed before any required downstream field whose offset would depend on that unknown width.
- A label or unit in this asset is descriptive metadata, not permission to use that field scientifically without technique-specific validation.

## Packed flag IDs

| Encoded ID | Physical storage | Mask | Meaning |
| ---: | --- | ---: | --- |
| 1 | uint8 packed byte | `0x03` | Mode code |
| 2 | shares ID 1 byte | `0x04` | Oxidation/reduction flag |
| 3 | shares ID 1 byte | `0x08` | Error flag |
| 21 | shares ID 1 byte | `0x10` | Control-change flag |
| 31 | shares ID 1 byte | `0x20` | Sequence/Ns-change flag |
| 65 | shares ID 1 byte | `0x80` | Counter-increment flag |

## Data-column storage registry

| Base ID | Storage | Bytes | Quantity / working label | Unit / note |
| ---: | --- | ---: | --- | --- |
| 4 | float64 | 8 | Elapsed time | s |
| 5 | float32 | 4 | Control value | V or mA |
| 6 | float32 | 4 | Working-electrode potential / technique-dependent potential | V |
| 7 | float64 | 8 | Incremental charge | mA·h |
| 8 | float32 | 4 | Current | mA |
| 9 | float32 | 4 | Counter-electrode potential | V |
| 11 | float64 | 8 | Mean current | mA |
| 13 | float64 | 8 | Charge relative to origin | mA·h |
| 15 | float32 | 4 | Phase of Z1 | deg |
| 16 | float32 | 4 | Analog input 1 | V |
| 17 | float32 | 4 | Analog input 2 | V |
| 19 | float32 | 4 | Voltage control value | V |
| 20 | float32 | 4 | Current control value | mA |
| 23 | float64 | 8 | Charge increment | mA·h |
| 24 | float64 | 8 | Cycle number | — |
| 32 | float32 | 4 | Frequency | Hz |
| 33 | float32 | 4 | Working-electrode voltage magnitude | V |
| 34 | float32 | 4 | Current magnitude | A |
| 35 | float32 | 4 | Impedance phase | deg |
| 36 | float32 | 4 | Impedance magnitude | Ω |
| 37 | float32 | 4 | Real impedance | Ω |
| 38 | float32 | 4 | Negative imaginary impedance | Ω |
| 39 | uint16 | 2 | Current-range code | — |
| 45 | float32 | 4 | Z1 magnitude | Ω |
| 46 | float32 | 4 | Z2 magnitude | Ω |
| 69 | float32 | 4 | Working-electrode resistance | Ω |
| 70 | float32 | 4 | Working-electrode power | W |
| 74 | float64 | 8 | Energy magnitude | W·h |
| 75 | float32 | 4 | Analog output | V |
| 76 | float32 | 4 | Mean current | mA |
| 77 | float32 | 4 | Mean working-electrode potential | V |
| 78 | float32 | 4 | Inverse-square series capacitance | µF⁻² |
| 96 | float32 | 4 | Counter-electrode voltage magnitude | V |
| 98 | float32 | 4 | Counter-electrode impedance phase | deg |
| 99 | float32 | 4 | Counter-electrode impedance magnitude | Ω |
| 100 | float32 | 4 | Counter-electrode real impedance | Ω |
| 101 | float32 | 4 | Counter-electrode negative imaginary impedance | Ω |
| 105 | float32 | 4 | Negative imaginary Z1 | Ω |
| 106 | float32 | 4 | Negative imaginary Z2 | Ω |
| 110 | float64 | 8 | Counter-electrode energy | W·h |
| 112 | float64 | 8 | Working-electrode energy | W·h |
| 115 | float64 | 8 | Counter-electrode charge energy | W·h |
| 116 | float64 | 8 | Counter-electrode discharge energy | W·h |
| 123 | float64 | 8 | Working-electrode charge energy | W·h |
| 124 | float64 | 8 | Working-electrode discharge energy | W·h |
| 125 | float64 | 8 | Charge capacitance | µF |
| 126 | float64 | 8 | Discharge capacitance | µF |
| 131 | uint16 | 2 | Sequence / Ns index | — |
| 135 | float32 | 4 | Mean E1 potential | V |
| 136 | float32 | 4 | Mean E2 potential | V |
| 163 | float32 | 4 | Stack-voltage magnitude | V |
| 166 | float32 | 4 | Stack-impedance phase | deg |
| 167 | float32 | 4 | Stack-impedance magnitude | Ω |
| 168 | float32 | 4 | Compensation resistance | Ω |
| 169 | float32 | 4 | Series capacitance | µF |
| 172 | float32 | 4 | Parallel capacitance | µF |
| 173 | float32 | 4 | Inverse-square parallel capacitance | µF⁻² |
| 174 | float32 | 4 | Context-dependent mean working potential / impedance phase | V or deg |
| 175 | float32 | 4 | Working-to-counter impedance magnitude | Ω |
| 176 | float32 | 4 | Working-to-counter real impedance | Ω |
| 177 | float32 | 4 | Working-to-counter negative imaginary impedance | Ω |
| 178 | float32 | 4 | Charge relative to origin | C |
| 179 | float32 | 4 | Charge increment | C |
| 182 | float64 | 8 | Step elapsed time | s |
| 185 | float32 | 4 | Mean counter-electrode potential | V |
| 206 | float32 | 4 | Temperature | °C |
| 211 | float64 | 8 | Charge/discharge quantity | source/technique dependent |
| 212 | uint32 | 4 | Half-cycle index | — |
| 213 | uint32 | 4 | Z-cycle index | — |
| 215 | float32 | 4 | Mean counter-electrode potential | V |
| 217 | float32 | 4 | Working-potential total harmonic distortion | % |
| 218 | float32 | 4 | Current total harmonic distortion | % |
| 219 | float32 | 4 | Counter-potential total harmonic distortion | % |
| 220 | float32 | 4 | Working-potential noise spectral density | % |
| 221 | float32 | 4 | Current noise spectral density | % |
| 222 | float32 | 4 | Counter-potential noise spectral density | % |
| 223 | float32 | 4 | Working-potential noise-to-response ratio | % |
| 224 | float32 | 4 | Current noise-to-response ratio | % |
| 225 | float32 | 4 | Counter-potential noise-to-response ratio | % |
| 230 | float32 | 4 | Working-potential harmonic 2 magnitude | V |
| 231 | float32 | 4 | Working-potential harmonic 3 magnitude | V |
| 232 | float32 | 4 | Working-potential harmonic 4 magnitude | V |
| 233 | float32 | 4 | Working-potential harmonic 5 magnitude | V |
| 234 | float32 | 4 | Working-potential harmonic 6 magnitude | V |
| 235 | float32 | 4 | Working-potential harmonic 7 magnitude | V |
| 236 | float32 | 4 | Current harmonic 2 magnitude | A |
| 237 | float32 | 4 | Current harmonic 3 magnitude | A |
| 238 | float32 | 4 | Current harmonic 4 magnitude | A |
| 239 | float32 | 4 | Current harmonic 5 magnitude | A |
| 240 | float32 | 4 | Current harmonic 6 magnitude | A |
| 241 | float32 | 4 | Current harmonic 7 magnitude | A |
| 242 | float32 | 4 | Counter-potential harmonic 2 magnitude | V |
| 243 | float32 | 4 | Counter-potential harmonic 3 magnitude | V |
| 244 | float32 | 4 | Counter-potential harmonic 4 magnitude | V |
| 245 | float32 | 4 | Counter-potential harmonic 5 magnitude | V |
| 246 | float32 | 4 | Counter-potential harmonic 6 magnitude | V |
| 247 | float32 | 4 | Counter-potential harmonic 7 magnitude | V |
| 248 | float32 | 4 | AC resistance | Ω |
| 249 | float32 | 4 | DC resistance | Ω |
| 253 | uint8 | 1 | ACIR/DCIR control code | — |

## Encoded-ID resolution examples

These examples illustrate the general ordinary-column rule. They are not special-case aliases.

| Full encoded ID | `encoded_id % 256` | Storage | Bytes | Working label |
| ---: | ---: | --- | ---: | --- |
| 379 | 123 | float64 | 8 | Working-electrode charge energy |
| 468 | 212 | uint32 | 4 | Half-cycle index |

A future encoded ID such as 635 would resolve to base ID 123 and therefore have the same registered 8-byte storage width. CellXplorer must still retain `635` as the source encoded ID rather than replacing it with `123` in diagnostics or provenance.

## CellXplorer GCPL-required subset

The current GCPL adapter depends on the following raw information after packed-flag decoding:

| Required concept | Base ID | Current CellXplorer raw field |
| --- | ---: | --- |
| Packed acquisition flags | exact encoded IDs 1/2/3/21/31/65 | `raw_flags` plus decoded flags |
| Sequence / Ns | 131 | `raw_sample_index` |
| Elapsed time | 4 | `elapsed_time_s` |
| Incremental charge | 7 | `raw_dq_mAh` |
| Control value | 5 | `raw_control_v_or_mA` |
| Working-electrode potential | 6 | `raw_ewe_v` |
| Charge/discharge quantity | 211 | `raw_q_charge_discharge_mAh` in the verified GCPL contract |
| Half-cycle index | 212 | `raw_half_cycle_index` |

For ordinary columns, any full encoded ID whose modulo-256 base equals the required base ID satisfies the binary-storage identity of that required field. Technique-specific semantic validation remains a separate adapter responsibility.

Counter-electrode potential base ID 9 remains optional for two-electrode sources and available when present for three-electrode semantics.

## Semantic cautions

- ID 5 is intrinsically control-mode dependent.
- ID 6 can be technique dependent; Spec 051 changes binary tolerance, not the existing GCPL semantic interpretation.
- ID 174 is context dependent and must not be assigned one unconditional scientific meaning merely from the numeric ID.
- ID 211 has a stable 8-byte storage definition, but unit/quantity interpretation must remain technique-specific. The existing CellXplorer GCPL interpretation established from project-owned files remains authoritative for that supported path.
- Multiple base IDs can represent similar scientific quantities at different precision, context, or technique generations. The registry must not collapse distinct base IDs solely because their labels resemble one another.

## Maintenance rule

When a new full encoded column ID is encountered, first calculate its modulo-256 base ID. If that base ID already exists in this registry, its storage width/type is known and the parser can continue without adding a one-off alias. Preserve the full encoded ID in diagnostics/provenance and add a focused regression test if the new encoding matters to supported workflows.

If the base ID is absent from the registry, establish the storage width/type independently before adding it. If the scientific meaning is not independently established, use a neutral label and keep it storage-only. Unknown base IDs must never be assigned a guessed width merely to make a file import.