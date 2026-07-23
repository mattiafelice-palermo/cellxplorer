# CellXplorer agent knowledge

This directory is the map of durable, cross-cutting knowledge for agents working on CellXplorer.
It complements source-level documentation and tests; it does not replace them. Start with the topic
that matches the change, then follow its links to the authoritative implementation.

## Topics

- [`architecture.md`](architecture.md): process layout, startup sequence, persistent data, and
  ownership boundaries.
- [`state-and-performance.md`](state-and-performance.md): SQLite concurrency, list endpoints,
  React Query persistence, analysis rendering, and performance failure modes.
- [`change-playbooks.md`](change-playbooks.md): checklists for schema, scientific calculations,
  frontend server state, releases, and Windows packaging.
- [`dcir-analysis.md`](dcir-analysis.md): DCIR rest/pulse recognition, calculation rules, private
  segment ownership, series structure, and cache boundaries.

Existing specialist references:

- [`../database-migrations.md`](../database-migrations.md)
- [`../parser-capacity-findings.md`](../parser-capacity-findings.md)
- [`../portable-analysis-html.md`](../portable-analysis-html.md)
- [`../steps-tab-series-redesign.md`](../steps-tab-series-redesign.md)
- [`../local-development.md`](../local-development.md)
- [`../windows-packaging.md`](../windows-packaging.md)
- [`../tauri-packaging-lessons.md`](../tauri-packaging-lessons.md)

## Updating this knowledge base

Add information when it is stable, verified, and useful outside one narrow edit. Good entries
include invariants, module boundaries, data-lifecycle rules, expensive operations, recurring
failure modes with confirmed causes, and commands that reliably verify a subsystem.

Prefer updating an existing topic over creating a new file. Create a topic only when the existing
files would become difficult to scan. Keep implementation details linked to source paths and tests
so future refactors have an obvious place to update the documentation.

Do not add transient status notes, speculative explanations, screenshots of temporary failures, or
instructions tied only to one agent environment. Git history and the changelog cover chronology;
this directory explains how the current system works.
