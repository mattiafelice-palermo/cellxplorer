import {
  ActionIcon,
  Box,
  Group,
  Menu,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconChartLine,
  IconChevronDown,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { get, type AnalysisSummary } from "../../../api";
import {
  ANALYSIS_WORKSPACE_CHANGED_EVENT,
  ANALYSIS_WORKSPACE_ACTIVE_EVENT,
  ANALYSIS_WORKSPACE_TABS_EVENT,
  clearAnalysisWorkspaceEditorState,
  getAnalysisWorkspaceEditorState,
  hasDirtyAnalysisWorkspaceEditors,
  loadAnalysisWorkspace,
  markAnalysisWorkspaceMounted,
  openAnalysisWorkspaceTab,
  saveAnalysisWorkspace,
  showAnalysisWorkspaceView,
  unmarkAnalysisWorkspaceMounted,
  type AnalysisWorkspaceSnapshot,
  type AnalysisWorkspaceTab,
} from "./analysisWorkspace";
import { ANALYSIS_LEAVE_EVENT, type AnalysisLeaveRequestDetail } from "../../../navigationEvents";
import { refreshAnalysisQueries } from "./analysisQueryCache";

function analysisIdFromPath(pathname: string): number | null {
  const match = pathname.match(/^\/analyses\/(\d+)$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function AnalysisWorkspaceTabs() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const analyses = useQuery({
    queryKey: ["analyses", ""],
    queryFn: () => get<AnalysisSummary[]>("/api/analyses"),
  });
  const [workspace, setWorkspace] = useState<AnalysisWorkspaceSnapshot>(loadAnalysisWorkspace);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragTargetId, setDragTargetId] = useState<number | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  const pointerDrag = useRef<{
    id: number;
    startX: number;
    grabOffsetX: number;
    offsetX: number;
    moved: boolean;
  } | null>(null);
  const suppressTabClick = useRef(false);
  const tabs = workspace.tabs;
  const closedTabs = workspace.closedTabs;
  const [dirtyIds, setDirtyIds] = useState<Set<number>>(
    () =>
      new Set(
        tabs
          .filter((tab) => {
            const state = getAnalysisWorkspaceEditorState(tab.id);
            return state?.dirty || state?.hasUnsavedPlot;
          })
          .map((tab) => tab.id),
      ),
  );
  const activeId = analysisIdFromPath(location.pathname);
  const [visibleId, setVisibleId] = useState<number | null>(activeId);
  const navigationFrame = useRef<number | null>(null);
  const navigationTimer = useRef<number | null>(null);
  const onHome = visibleId === null;
  const summaries = useMemo(
    () => new Map((analyses.data ?? []).map((analysis) => [analysis.id, analysis])),
    [analyses.data],
  );

  useEffect(() => {
    setVisibleId(activeId);
  }, [activeId]);

  useEffect(() => {
    const onActiveChange = (event: Event) => {
      setVisibleId((event as CustomEvent<number | null>).detail);
    };
    window.addEventListener(ANALYSIS_WORKSPACE_ACTIVE_EVENT, onActiveChange);
    return () => window.removeEventListener(ANALYSIS_WORKSPACE_ACTIVE_EVENT, onActiveChange);
  }, []);

  useEffect(() => () => {
    if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current);
    if (navigationTimer.current !== null) window.clearTimeout(navigationTimer.current);
  }, []);

  useEffect(() => {
    const onTabsChange = (event: Event) => {
      setWorkspace((event as CustomEvent<AnalysisWorkspaceSnapshot>).detail);
    };
    window.addEventListener(ANALYSIS_WORKSPACE_TABS_EVENT, onTabsChange);
    return () => window.removeEventListener(ANALYSIS_WORKSPACE_TABS_EVENT, onTabsChange);
  }, []);

  const navigateAfterPaint = (path: string, analysisId: number | null) => {
    showAnalysisWorkspaceView(analysisId);
    if (navigationFrame.current !== null) window.cancelAnimationFrame(navigationFrame.current);
    if (navigationTimer.current !== null) window.clearTimeout(navigationTimer.current);
    navigationFrame.current = window.requestAnimationFrame(() => {
      navigationFrame.current = null;
      navigationTimer.current = window.setTimeout(() => {
        navigationTimer.current = null;
        navigate(path);
      }, 0);
    });
  };

  /** Leave the visible analysis without closing its tab (auto-draft on navigate). */
  const leaveActiveThenNavigate = (path: string, analysisId: number | null) => {
    const proceed = () => navigateAfterPaint(path, analysisId);
    if (visibleId === null || analysisId !== null) {
      proceed();
      return;
    }
    const event = new CustomEvent<AnalysisLeaveRequestDetail>(ANALYSIS_LEAVE_EVENT, {
      cancelable: true,
      detail: { proceed, reason: "navigate" },
    });
    if (window.dispatchEvent(event)) proceed();
  };

  useEffect(() => {
    if (activeId === null) return;
    const path = `${location.pathname}${location.search}`;
    setWorkspace((currentWorkspace) => {
      const current = currentWorkspace.tabs;
      const existing = current.find((tab) => tab.id === activeId);
      const title =
        getAnalysisWorkspaceEditorState(activeId)?.title ||
        summaries.get(activeId)?.title ||
        existing?.title ||
        `Analysis ${activeId}`;
      if (existing?.path === path && existing.title === title) return currentWorkspace;
      const next = existing
        ? current.map((tab) => (tab.id === activeId ? { ...tab, title, path } : tab))
        : [...current, { id: activeId, title, path }];
      saveAnalysisWorkspace(next, currentWorkspace.closedTabs.filter((tab) => tab.id !== activeId));
      return { ...currentWorkspace, tabs: next };
    });
    markAnalysisWorkspaceMounted(activeId);
  }, [activeId, location.pathname, location.search, summaries]);

  useEffect(() => {
    if (!analyses.data) return;
    const validIds = new Set(analyses.data.map((analysis) => analysis.id));
    setWorkspace((currentWorkspace) => {
      const next = currentWorkspace.tabs
        .filter((tab) => validIds.has(tab.id))
        .map((tab) => ({ ...tab, title: summaries.get(tab.id)?.title ?? tab.title }));
      const nextClosed = currentWorkspace.closedTabs.filter((tab) => validIds.has(tab.id));
      if (
        next.length === currentWorkspace.tabs.length &&
        nextClosed.length === currentWorkspace.closedTabs.length &&
        next.every((tab, index) =>
          tab.id === currentWorkspace.tabs[index].id && tab.title === currentWorkspace.tabs[index].title
        )
      ) {
        return currentWorkspace;
      }
      saveAnalysisWorkspace(next, nextClosed);
      return { version: 1, tabs: next, closedTabs: nextClosed };
    });
  }, [analyses.data, summaries]);

  useEffect(() => {
    const onWorkspaceChange = (event: Event) => {
      const detail = (event as CustomEvent<{
        analysisId: number;
        title: string | null;
        dirty: boolean;
      }>).detail;
      setDirtyIds((current) => {
        const next = new Set(current);
        if (detail.dirty) next.add(detail.analysisId);
        else next.delete(detail.analysisId);
        return next;
      });
      if (detail.title) {
        setWorkspace((currentWorkspace) => {
          const next = currentWorkspace.tabs.map((tab) =>
            tab.id === detail.analysisId ? { ...tab, title: detail.title! } : tab,
          );
          saveAnalysisWorkspace(next, currentWorkspace.closedTabs);
          return { ...currentWorkspace, tabs: next };
        });
      }
    };
    window.addEventListener(ANALYSIS_WORKSPACE_CHANGED_EVENT, onWorkspaceChange);
    return () => window.removeEventListener(ANALYSIS_WORKSPACE_CHANGED_EVENT, onWorkspaceChange);
  }, []);

  useEffect(() => {
    if (![...dirtyIds].length) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirtyAnalysisWorkspaceEditors()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyIds]);

  const activateTab = (tab: AnalysisWorkspaceTab) => {
    markAnalysisWorkspaceMounted(tab.id);
    navigateAfterPaint(tab.path, tab.id);
    const refresh = () => void refreshAnalysisQueries(queryClient, tab.id);
    const requestIdle = (window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    }).requestIdleCallback;
    if (requestIdle) {
      requestIdle(refresh, { timeout: 1000 });
    } else {
      globalThis.setTimeout(refresh, 150);
    }
  };

  const removeTab = (id: number, remember = true) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const removed = tabs[index];
    const next = tabs.filter((tab) => tab.id !== id);
    const nextClosed = removed && remember
      ? [removed, ...closedTabs.filter((tab) => tab.id !== id)].slice(0, 20)
      : closedTabs.filter((tab) => tab.id !== id);
    saveAnalysisWorkspace(next, nextClosed);
    setWorkspace({ version: 1, tabs: next, closedTabs: nextClosed });
    setDirtyIds((current) => {
      const updated = new Set(current);
      updated.delete(id);
      return updated;
    });
    clearAnalysisWorkspaceEditorState(id);
    unmarkAnalysisWorkspaceMounted(id);
    if (visibleId === id) {
      const fallback = next[Math.min(index, next.length - 1)];
      if (fallback) activateTab(fallback);
      else navigateAfterPaint("/analyses", null);
    }
  };

  const reopenLastClosed = () => {
    const tab = closedTabs[0];
    if (!tab) return;
    const next = openAnalysisWorkspaceTab(tab);
    setWorkspace(next);
    activateTab(tab);
  };

  const reorderTabToIndex = (sourceId: number, insertionIndex: number) => {
    setWorkspace((currentWorkspace) => {
      const moved = currentWorkspace.tabs.find((tab) => tab.id === sourceId);
      if (!moved) return currentWorkspace;
      const remaining = currentWorkspace.tabs.filter((tab) => tab.id !== sourceId);
      const boundedIndex = Math.max(0, Math.min(insertionIndex, remaining.length));
      const next = [...remaining];
      next.splice(boundedIndex, 0, moved);
      if (next.every((tab, index) => tab.id === currentWorkspace.tabs[index]?.id)) {
        return currentWorkspace;
      }
      saveAnalysisWorkspace(next, currentWorkspace.closedTabs);
      return { ...currentWorkspace, tabs: next };
    });
  };

  const finishTabDrag = () => {
    const moved = pointerDrag.current?.moved === true;
    pointerDrag.current = null;
    setDraggedId(null);
    setDragTargetId(null);
    setDragOffsetX(0);
    if (moved) {
      suppressTabClick.current = true;
      window.setTimeout(() => {
        suppressTabClick.current = false;
      }, 0);
    }
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag) return;
      if (!drag.moved && Math.abs(event.clientX - drag.startX) >= 5) {
        drag.moved = true;
        setDraggedId(drag.id);
      }
      if (!drag.moved) return;
      event.preventDefault();

      const draggedElement = document.querySelector<HTMLElement>(
        `[data-analysis-tab-id="${drag.id}"]`,
      );
      if (draggedElement) {
        const rect = draggedElement.getBoundingClientRect();
        const baseLeft = rect.left - drag.offsetX;
        const nextOffset = event.clientX - drag.grabOffsetX - baseLeft;
        drag.offsetX = nextOffset;
        setDragOffsetX(nextOffset);
      }

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>("[data-analysis-tab-id]"),
      )
        .filter((element) => Number(element.dataset.analysisTabId) !== drag.id)
        .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
      const insertionIndex = candidates.findIndex((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return event.clientX < rect.left + rect.width / 2;
      });
      const boundedIndex = insertionIndex < 0 ? candidates.length : insertionIndex;
      const target = candidates[boundedIndex] ?? candidates[candidates.length - 1];
      setDragTargetId(target ? Number(target.dataset.analysisTabId) : null);
      reorderTabToIndex(drag.id, boundedIndex);
    };
    const onPointerEnd = () => finishTabDrag();
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onPointerEnd);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onPointerEnd);
    };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "t" && event.shiftKey) {
        event.preventDefault();
        reopenLastClosed();
        return;
      }
      if (key === "t") {
        event.preventDefault();
        leaveActiveThenNavigate("/analyses?new=1", null);
        return;
      }
      if (key !== "tab") return;
      event.preventDefault();
      const destinations = [null, ...tabs.map((tab) => tab.id)];
      const current = onHome ? 0 : Math.max(0, destinations.indexOf(visibleId));
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex = (current + direction + destinations.length) % destinations.length;
      const nextId = destinations[nextIndex];
      if (nextId === null) leaveActiveThenNavigate("/analyses", null);
      else {
        const tab = tabs.find((candidate) => candidate.id === nextId);
        if (tab) activateTab(tab);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [closedTabs, navigate, onHome, tabs, visibleId]);

  const closeTab = (id: number) => {
    const finishClose = () => removeTab(id);
    if (id !== visibleId && dirtyIds.has(id)) {
      // Activate first so AnalysisEditor's leave listener can open the same prompts
      // used for navigation — do not show a second, different dialog.
      const tab = tabs.find((candidate) => candidate.id === id);
      if (tab) activateTab(tab);
      window.setTimeout(() => {
        const event = new CustomEvent<AnalysisLeaveRequestDetail>(ANALYSIS_LEAVE_EVENT, {
          cancelable: true,
          detail: { proceed: finishClose, reason: "close-tab" },
        });
        if (window.dispatchEvent(event)) finishClose();
      }, 0);
      return;
    }
    if (id !== visibleId) {
      removeTab(id);
      return;
    }
    const event = new CustomEvent<AnalysisLeaveRequestDetail>(ANALYSIS_LEAVE_EVENT, {
      cancelable: true,
      detail: { proceed: finishClose, reason: "close-tab" },
    });
    if (window.dispatchEvent(event)) finishClose();
  };

  const tabButton = (tab: AnalysisWorkspaceTab) => {
    const active = visibleId === tab.id;
    return (
      <Box
        key={tab.id}
        component="div"
        data-analysis-tab-id={tab.id}
        role="tab"
        tabIndex={0}
        aria-selected={active}
        aria-label={`Open ${tab.title}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest("[data-tab-close]")) return;
          const rect = event.currentTarget.getBoundingClientRect();
          pointerDrag.current = {
            id: tab.id,
            startX: event.clientX,
            grabOffsetX: event.clientX - rect.left,
            offsetX: 0,
            moved: false,
          };
        }}
        onClick={(event) => {
          if (suppressTabClick.current) {
            event.preventDefault();
            return;
          }
          activateTab(tab);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            activateTab(tab);
          }
        }}
        style={{
          display: "flex",
          alignItems: "stretch",
          minWidth: 150,
          maxWidth: 230,
          height: 40,
          borderRight: "1px solid var(--mantine-color-gray-3)",
          borderBottom: active ? "2px solid var(--mantine-primary-color-6)" : "2px solid transparent",
          background:
            dragTargetId === tab.id && draggedId !== tab.id
              ? "light-dark(var(--mantine-primary-color-0), var(--mantine-primary-color-9))"
              : active
                ? "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))"
                : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
          opacity: draggedId === tab.id ? 0.78 : 1,
          outline: draggedId === tab.id ? "1px solid var(--mantine-primary-color-5)" : undefined,
          boxShadow:
            draggedId === tab.id
              ? "0 5px 14px rgba(0, 0, 0, 0.14)"
              : dragTargetId === tab.id
                ? "inset 2px 0 var(--mantine-primary-color-6)"
                : undefined,
          transition: "background 100ms ease, box-shadow 100ms ease, opacity 100ms ease",
          cursor: draggedId === tab.id ? "grabbing" : "grab",
          userSelect: "none",
          touchAction: "none",
          transform: draggedId === tab.id ? `translateX(${dragOffsetX}px)` : undefined,
          zIndex: draggedId === tab.id ? 2 : 1,
          flexShrink: 0,
        }}
      >
        <Box
          style={{ minWidth: 0, flex: 1, padding: "0 8px 0 14px", cursor: "inherit" }}
        >
          <Group gap={7} wrap="nowrap" h="100%">
            <Text size="sm" fw={active ? 600 : 400} truncate>
              {tab.title}
            </Text>
            {dirtyIds.has(tab.id) ? (
              <Box
                aria-label="Unsaved changes"
                w={7}
                h={7}
                bg="var(--mantine-primary-color-6)"
                style={{ borderRadius: "50%", flexShrink: 0 }}
              />
            ) : null}
          </Group>
        </Box>
        <Tooltip label="Close analysis" withArrow>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            my="auto"
            mr={7}
            aria-label={`Close ${tab.title}`}
            data-tab-close
            draggable={false}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              closeTab(tab.id);
            }}
          >
            <IconX size={14} />
          </ActionIcon>
        </Tooltip>
      </Box>
    );
  };

  return (
    <>
    <Box
      mx="calc(-1 * var(--mantine-spacing-md))"
      mt="calc(-1 * var(--mantine-spacing-md))"
      mb="md"
      style={{
        display: "flex",
        height: 41,
        position: "sticky",
        top: "var(--app-shell-header-height, 52px)",
        zIndex: 90,
        borderBottom: "1px solid var(--mantine-color-gray-3)",
        background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
      }}
    >
      <Box
        style={{
          display: "flex",
          minWidth: 0,
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
        }}
      >
        <Box
          style={{
            display: "flex",
            alignItems: "stretch",
            height: 40,
            flexShrink: 0,
            borderRight: "1px solid var(--mantine-color-gray-3)",
            borderBottom: onHome ? "2px solid var(--mantine-primary-color-6)" : "2px solid transparent",
            background: onHome ? "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))" : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
          }}
        >
          <UnstyledButton
            aria-label="Open analysis database"
            onClick={() => leaveActiveThenNavigate("/analyses", null)}
            px="md"
          >
            <Group gap="xs" wrap="nowrap">
              <IconChartLine size={15} />
              <Text size="sm" fw={onHome ? 600 : 500}>Analyses</Text>
            </Group>
          </UnstyledButton>
        </Box>
        {tabs.map(tabButton)}
      </Box>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            h={40}
            w={42}
            radius={0}
            aria-label="Open analysis tabs"
            style={{ flexShrink: 0, borderLeft: "1px solid var(--mantine-color-gray-3)" }}
          >
            <IconChevronDown size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconChartLine size={15} />} onClick={() => leaveActiveThenNavigate("/analyses", null)}>
            Analyses
          </Menu.Item>
          {tabs.length ? <Menu.Divider /> : null}
          {tabs.map((tab) => (
            <Menu.Item
              key={tab.id}
              onClick={() => activateTab(tab)}
              rightSection={
                dirtyIds.has(tab.id) ? (
                  <Box
                    aria-label="Unsaved changes"
                    w={7}
                    h={7}
                    bg="var(--mantine-primary-color-6)"
                    style={{ borderRadius: "50%" }}
                  />
                ) : null
              }
            >
              {tab.title}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Box>
    </>
  );
}
