# 093 — Reachable Cell Database horizontal scrollbar

Status: Complete; all four canonical preflight stages passed.

Keep a horizontal scrollbar at the bottom of the visible Cell table while the
page scrolls vertically. Synchronize it with native horizontal table scrolling.
Fade row content beneath the scrollbar using theme colors. Only show the dock
when horizontal overflow exists; keep it within the table boundaries. Observe
column and viewport size changes, including live column resizing and UI zoom.

Validation: production build and type check passed. Browser geometry confirmed
the scrollbar at the viewport bottom, with synchronized keyboard scrolling
and a theme-aware row fade; screenshot checked in dark mode. End padding keeps
the table totals clear of the dock.
