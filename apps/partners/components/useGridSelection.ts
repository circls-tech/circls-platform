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
  }, [slots, weekStart]);

  // Drag state — we need refs so event handlers don't stale-close over state.
  const dragStart = useRef<{ dayIndex: number; rowIndex: number } | null>(null);
  const cellMap = useRef<Map<string, { dayIndex: number; rowIndex: number }>>(new Map());

  /** Called by the grid to register every (slotId → cell coordinate) mapping. */
  const registerCell = useCallback(
    (slotId: string, dayIndex: number, rowIndex: number) => {
      cellMap.current.set(slotId, { dayIndex, rowIndex });
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

  /** Select all slot ids for a specific day column. */
  const selectDay = useCallback((dayIndex: number) => {
    const ids: string[] = [];
    cellMap.current.forEach((cell, slotId) => {
      if (cell.dayIndex === dayIndex) ids.push(slotId);
    });
    setSelected(new Set(ids));
  }, []);

  /** Select all slot ids for a specific time row. */
  const selectRow = useCallback((rowIndex: number) => {
    const ids: string[] = [];
    cellMap.current.forEach((cell, slotId) => {
      if (cell.rowIndex === rowIndex) ids.push(slotId);
    });
    setSelected(new Set(ids));
  }, []);

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
