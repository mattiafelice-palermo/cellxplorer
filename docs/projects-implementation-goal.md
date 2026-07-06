# Folder Workspace Implementation Goal

Date: 2026-07-05

## Final Navigation Model

The app should expose four main work areas:

- Import
- Cell Database
- Analysis Database
- Projects

The Cell Database and Analysis Database are flat canonical repositories. They answer: "what exists in the app?"

Projects is the organizational workspace page. For now it is folder-only: the last node in a folder tree is the working context, so there is no separate project node type in the UI.

## Canonical Ownership

Cells and analyses are not owned by folders. They live in their databases.

Folders contain references to cells and analyses. Deleting or moving folders must not delete raw data, cached cycling data, cells, or analyses unless a separate explicit destructive action is added later.

## Folder Direction

Projects should be a full page rather than a tree embedded in the left sidebar.

The left navigation should stay compact:

- Import
- Cell Database
- Analysis Database
- Projects

The Projects page should provide the folder workspace with enough room for creation, movement, grouping, and previews.

## Final Folder Workspace Capabilities

Target capabilities:

- Create folders and subfolders.
- Rename folders.
- Remove folders safely.
- Move folders/items with a robust "Move to..." command.
- Add existing cells from the Cell Database into a selected folder.
- Import a cell directly into the current selected context.
- Create analyses directly inside the current context.
- Show cells and analyses together in the organized workspace.
- Support replicate/formulation groups later, most likely as a folder-level feature.
- Provide a hideable right preview panel.
- Preview selected cells with plot, metadata, source status, and file/test details.
- Preview selected analyses once analysis logic exists.
- Show unfiled cells/analyses or make them easy to find from the databases.

Drag-and-drop is desirable later, but the first version should prioritize explicit reliable controls.

## First Version Scope

Recommended first implementation:

1. Rename Library to Cell Database.
2. Rename Analyses to Analysis Database.
3. Remove the data tree from the left sidebar.
4. Add a Projects page.
5. Move folder organization into that page.
6. Add folder creation from that page.
7. Add safe delete/rename/move controls.
8. Add a right preview panel that can be hidden and reopened.
9. Add existing-cell assignment from the Cell Database to a folder.
10. Add "Import here" so imported cells are immediately filed in the selected folder.
11. Add "New analysis" inside a folder once analysis creation exists.

## Deferred Design Question

The app may eventually need a separate "project" concept if a workspace needs behavior that folders should not have: project-level permissions, summaries, reports, locked datasets, or global settings.

Until that need is real, folders are the single organizational primitive.
