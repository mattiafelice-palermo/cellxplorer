"""Database models.

Identity layer:   SourceFile, Cell, Test (+ TestFile ordered join)
Organization:     Folder (+ FolderCell, FolderReplicateGroup), ReplicateGroup
                  (+ ReplicateGroupCell), Project (+ ProjectCell), Group (+ GroupCell)
Faceted layer:    Tag (+ CellTag, AnalysisTag), Collection (+ AnalysisCollection)
Analysis layer:   Analysis (spec + provenance as versioned JSON documents)

The one architectural rule: containment never does the work of reference.
Folders/projects/groups store *references* to cells; analyses store explicit
frozen references to cells/groups. Nothing here copies data or implies scope.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- identity


class SourceFile(Base):
    """One Neware binary file. Identity = content hash; path is mutable."""

    __tablename__ = "source_files"

    id: Mapped[int] = mapped_column(primary_key=True)
    hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    path: Mapped[str] = mapped_column(Text)  # current location (mutable attribute)
    filename: Mapped[str] = mapped_column(String(255))
    size: Mapped[int] = mapped_column(Integer)
    ext: Mapped[str] = mapped_column(String(10))  # nda | ndax

    # header metadata (extracted without full parse)
    nda_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    device_info: Mapped[str | None] = mapped_column(String(255), nullable=True)
    channel: Mapped[str | None] = mapped_column(String(50), nullable=True)
    barcode: Mapped[str | None] = mapped_column(String(255), nullable=True)
    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_time: Mapped[str | None] = mapped_column(String(50), nullable=True)
    active_mass_mg: Mapped[float | None] = mapped_column(Float, nullable=True)
    nominal_capacity_mah: Mapped[float | None] = mapped_column(Float, nullable=True)
    header_meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # lifecycle
    # location_status: online | offline | changed  (path-level, reactive badge)
    location_status: Mapped[str] = mapped_column(String(20), default="online")
    # parse_status: unparsed | parsing | parsed | error
    parse_status: Mapped[str] = mapped_column(String(20), default="unparsed")
    parse_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    parser_version: Mapped[str | None] = mapped_column(String(30), nullable=True)
    row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cycle_count: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    test_link: Mapped[TestFile | None] = relationship(back_populates="file", uselist=False)


class Cell(Base):
    """The physical cell — the scientific object users think in."""

    __tablename__ = "cells"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    archived: Mapped[bool] = mapped_column(default=False)  # soft delete only
    cycling_status: Mapped[str] = mapped_column(String(20), default="active")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    tests: Mapped[list[Test]] = relationship(back_populates="cell", order_by="Test.id")
    metadata_entries: Mapped[list[CellMetadata]] = relationship(
        back_populates="cell", cascade="all, delete-orphan"
    )
    tag_links: Mapped[list[CellTag]] = relationship(cascade="all, delete-orphan")


class CellMetadata(Base):
    """Structured metadata as key/value; keys are free but shared across cells."""

    __tablename__ = "cell_metadata"
    __table_args__ = (UniqueConstraint("cell_id", "key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)
    key: Mapped[str] = mapped_column(String(100), index=True)
    value: Mapped[str] = mapped_column(Text)

    cell: Mapped[Cell] = relationship(back_populates="metadata_entries")


class Test(Base):
    """One cycling procedure on one cell: an ordered list of SourceFiles
    stitched into one continuous cycle-numbered record."""

    __tablename__ = "tests"

    id: Mapped[int] = mapped_column(primary_key=True)
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    cell: Mapped[Cell] = relationship(back_populates="tests")
    file_links: Mapped[list[TestFile]] = relationship(
        back_populates="test", order_by="TestFile.position", cascade="all, delete-orphan"
    )


class TestFile(Base):
    """Ordered membership of a file in a test. A file belongs to ONE test."""

    __tablename__ = "test_files"
    __table_args__ = (UniqueConstraint("file_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    test_id: Mapped[int] = mapped_column(ForeignKey("tests.id", ondelete="CASCADE"), index=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("source_files.id", ondelete="CASCADE"))
    position: Mapped[int] = mapped_column(Integer, default=0)

    test: Mapped[Test] = relationship(back_populates="file_links")
    file: Mapped[SourceFile] = relationship(back_populates="test_link")


# ------------------------------------------------------------ organization


class Folder(Base):
    """Navigation node in the workspace tree.

    Folders organize references to cells and analyses. They never own or copy
    scientific data.
    """

    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    position: Mapped[int] = mapped_column(Integer, default=0)


class FolderCell(Base):
    __tablename__ = "folder_cells"
    __table_args__ = (UniqueConstraint("folder_id", "cell_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), index=True)
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


class ReplicateGroup(Base):
    """Named set of replicate cells.

    Cells remain independent scientific objects; the group is a reference layer
    used for organization and aggregate previews.
    """

    __tablename__ = "replicate_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    cell_links: Mapped[list[ReplicateGroupCell]] = relationship(
        back_populates="group", order_by="ReplicateGroupCell.position", cascade="all, delete-orphan"
    )
    folder_links: Mapped[list[FolderReplicateGroup]] = relationship(
        back_populates="group", cascade="all, delete-orphan"
    )


class ReplicateGroupCell(Base):
    __tablename__ = "replicate_group_cells"
    __table_args__ = (UniqueConstraint("group_id", "cell_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("replicate_groups.id", ondelete="CASCADE"), index=True
    )
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)

    group: Mapped[ReplicateGroup] = relationship(back_populates="cell_links")
    cell: Mapped[Cell] = relationship()


class FolderReplicateGroup(Base):
    __tablename__ = "folder_replicate_groups"
    __table_args__ = (UniqueConstraint("folder_id", "group_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int] = mapped_column(ForeignKey("folders.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[int] = mapped_column(
        ForeignKey("replicate_groups.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)

    group: Mapped[ReplicateGroup] = relationship(back_populates="folder_links")


class Project(Base):
    """A working context: cell references, groups, filed analyses."""

    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    cell_links: Mapped[list[ProjectCell]] = relationship(cascade="all, delete-orphan")
    groups: Mapped[list[Group]] = relationship(
        back_populates="project", order_by="Group.position", cascade="all, delete-orphan"
    )


class ProjectCell(Base):
    __tablename__ = "project_cells"
    __table_args__ = (UniqueConstraint("project_id", "cell_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)


class Group(Base):
    """A named, ordered set of cell references — the explicit replicate
    concept. Deliberately THIN: references + label + order, nothing else."""

    __tablename__ = "groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    color: Mapped[str | None] = mapped_column(String(20), nullable=True)
    position: Mapped[int] = mapped_column(Integer, default=0)

    project: Mapped[Project] = relationship(back_populates="groups")
    cell_links: Mapped[list[GroupCell]] = relationship(
        order_by="GroupCell.position", cascade="all, delete-orphan"
    )


class GroupCell(Base):
    __tablename__ = "group_cells"
    __table_args__ = (UniqueConstraint("group_id", "cell_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("groups.id", ondelete="CASCADE"), index=True)
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


# ----------------------------------------------------------------- facets


class Tag(Base):
    """Centrally registered free label for cells and analyses."""

    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class CellTag(Base):
    __tablename__ = "cell_tags"
    __table_args__ = (UniqueConstraint("cell_id", "tag_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    cell_id: Mapped[int] = mapped_column(ForeignKey("cells.id", ondelete="CASCADE"), index=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), index=True)


class AnalysisTag(Base):
    __tablename__ = "analysis_tags"
    __table_args__ = (UniqueConstraint("analysis_id", "tag_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    analysis_id: Mapped[int] = mapped_column(ForeignKey("analyses.id", ondelete="CASCADE"), index=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), index=True)


class Collection(Base):
    """Optional named set of analyses. FLAT, many-to-many, no nesting."""

    __tablename__ = "collections"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AnalysisCollection(Base):
    __tablename__ = "analysis_collections"
    __table_args__ = (UniqueConstraint("analysis_id", "collection_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    analysis_id: Mapped[int] = mapped_column(ForeignKey("analyses.id", ondelete="CASCADE"), index=True)
    collection_id: Mapped[int] = mapped_column(ForeignKey("collections.id", ondelete="CASCADE"), index=True)


# --------------------------------------------------------------- analyses


class Analysis(Base):
    """A persistent specification (recipe). The spec/provenance are versioned
    JSON documents (see SPEC.md 'Analysis spec format'). Filing is OPTIONAL:
    both folder_id and project_id nullable = homeless, found via the index.
    Filing has ZERO effect on what data the analysis can reach."""

    __tablename__ = "analyses"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(255))
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), nullable=True, index=True
    )
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True, index=True
    )
    spec: Mapped[dict] = mapped_column(JSON)
    provenance: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    modified_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    tag_links: Mapped[list[AnalysisTag]] = relationship(cascade="all, delete-orphan")
    collection_links: Mapped[list[AnalysisCollection]] = relationship(cascade="all, delete-orphan")
