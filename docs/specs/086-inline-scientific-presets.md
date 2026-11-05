# 086 — Create scientific presets during Cell editing

Status: Complete; four-worker no-cache preflight passed. Branch: `codex/inline-scientific-presets`.
Review document: [Cumulative Astra review and follow-ups](reviews/087-table-electrode-controls-review.md).

Add a material-specific-capacity or electrode-area preset from separate import,
continued import, and the Cell metadata editor. A compact modal validates the
name and positive value. Saving appends to the corresponding Settings list,
selects the new preset in the current draft, and calculates nominal capacity
from the effective mass when available. A new preset does not change the
existing global default. Cancel leaves the preset lists unchanged.

The append API serializes local read/append/write transactions so concurrent
creation from separate editors does not lose entries. It uses existing Settings
validation and retains the existing defaults. Presets are presentation/user
settings; source metadata remains unchanged.

Focused Settings tests cover preservation, validation, duplicate names and
concurrent appends. Browser checks created and selected material and area
presets in the metadata editor, an area preset during separate import, and a
material preset in continued import; the Settings page displayed both types.

Follow-up: reserve a 12 px scrollbar gutter below analysis rows and close the
import dialog immediately when registration and preparation are complete,
removing the three-second automatic-close countdown. The current-source browser
shows the gutter; full preflight passed all four stages outside the Windows
sandbox (directory-alias fixtures require ordinary filesystem permissions).
