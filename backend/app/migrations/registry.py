from __future__ import annotations

from dataclasses import dataclass
from types import ModuleType

from .versions import v0001_initial, v0002_max_discharge_summary, v0003_import_submissions


@dataclass(frozen=True)
class MigrationRevision:
    revision: str
    down_revision: str | None
    module: ModuleType


REVISIONS = (
    MigrationRevision(
        revision=v0001_initial.revision,
        down_revision=v0001_initial.down_revision,
        module=v0001_initial,
    ),
    MigrationRevision(
        revision=v0002_max_discharge_summary.revision,
        down_revision=v0002_max_discharge_summary.down_revision,
        module=v0002_max_discharge_summary,
    ),
    MigrationRevision(
        revision=v0003_import_submissions.revision,
        down_revision=v0003_import_submissions.down_revision,
        module=v0003_import_submissions,
    ),
)

CURRENT_SCHEMA_REVISION = REVISIONS[-1].revision
REVISION_BY_ID = {migration.revision: migration for migration in REVISIONS}

for index, migration in enumerate(REVISIONS):
    expected_parent = REVISIONS[index - 1].revision if index else None
    if migration.down_revision != expected_parent:
        raise RuntimeError(
            f"Migration {migration.revision} points to {migration.down_revision!r}; "
            f"expected {expected_parent!r}."
        )


def revisions_after(current_revision: str | None) -> list[MigrationRevision]:
    if current_revision is None:
        return list(REVISIONS)
    for index, migration in enumerate(REVISIONS):
        if migration.revision == current_revision:
            return list(REVISIONS[index + 1 :])
    raise KeyError(current_revision)
