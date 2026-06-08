'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Slot } from '@/lib/api/types';

export interface GridCell {
  slotId: string;
  dayIndex: number;  // 0–6
  rowIndex: number;  // row within sorted time labels
}

export function useGridSelection(slots: Slot[], weekStart: Date) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Reset when slots or weekStart change identity.
  useEffect(() => {
    setSelected(new Set());
    cellMap.current = new Map();
  }, [slots, weekStart]);

  // Drag state — we need refs so event handlers don't stale-close over state.
  const dragStart = useRef<{ dayIndex: number; rowIndex: number } | null>(null);
  const cellMap = useRef<Map<string, { dayIndex: number; rowIndex: number; locked: boolean }>>(new Map());

  /**
   * Called by the grid to register every (slotId → cell coordinate) mapping,
   * with a `locked` flag. Locked (past) cells are registered too, but every
   * selection helper skips them — so re-registering with an updated flag on the
   * 60s `now` tick keeps selection correct without rebuilding cellMap.
   */
  const registerCell = useCallback(
    (slotId: string, dayIndex: number, rowIndex: number, locked = false) => {
      cellMap.current.set(slotId, { dayIndex, rowIndex, locked });
    },
    [],
  );

  /** Compute the set of slot ids within the rectangular range. */
  const slotIdsInRect = useCallback(
    (r0: number, c0: number, r1: number, c1: number): string[] => {
      const minR = Math.min(r0, r1);
      const maxR = Math.max(r0, r1);
      const minC = Math.min(c0, c1);
      const maxC = Math.max(c0, c1);
      const ids: string[] = [];
      cellMap.current.forEach((cell, slotId) => {
        if (
          !cell.locked &&
          cell.rowIndex >= minR &&
          cell.rowIndex <= maxR &&
          cell.dayIndex >= minC &&
          cell.dayIndex <= maxC
        ) {
          ids.push(slotId);
        }
      });
      return ids;
    },
    [],
  );

  const handleCellPointerDown = useCallback(
    (slotId: string, dayIndex: number, rowIndex: number) => {
      dragStart.current = { dayIndex, rowIndex };
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(slotId)) {
          next.delete(slotId);
        } else {
          next.add(slotId);
        }
        return next;
      });
    },
    [],
  );

  const handleCellPointerEnter = useCallback(
    (dayIndex: number, rowIndex: number) => {
      if (dragStart.current === null) return;
      const ids = slotIdsInRect(
        dragStart.current.rowIndex,
        dragStart.current.dayIndex,
        rowIndex,
        dayIndex,
      );
      setSelected(new Set(ids));
    },
    [slotIdsInRect],
  );

  const handlePointerUp = useCallback(() => {
    dragStart.current = null;
  }, []);

  /**
   * Add a group of slot ids to the selection, or remove them if they're all
   * already selected. This makes row/column header clicks behave as a toggle
   * that accumulates across multiple rows and columns: the first click on a
   * header selects its whole line; clicking it again (when every cell in that
   * line is selected) deselects just that line.
   */
  const toggleGroup = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      if (allSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  }, []);

  /** Toggle all (unlocked) slot ids for a specific day column. */
  const selectDay = useCallback(
    (dayIndex: number) => {
      const ids: string[] = [];
      cellMap.current.forEach((cell, slotId) => {
        if (cell.dayIndex === dayIndex && !cell.locked) ids.push(slotId);
      });
      toggleGroup(ids);
    },
    [toggleGroup],
  );

  /** Toggle all (unlocked) slot ids for a specific time row. */
  const selectRow = useCallback(
    (rowIndex: number) => {
      const ids: string[] = [];
      cellMap.current.forEach((cell, slotId) => {
        if (cell.rowIndex === rowIndex && !cell.locked) ids.push(slotId);
      });
      toggleGroup(ids);
    },
    [toggleGroup],
  );

  return {
    selected,
    registerCell,
    handleCellPointerDown,
    handleCellPointerEnter,
    handlePointerUp,
    selectDay,
    selectRow,
  };
}
