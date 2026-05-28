"use client"

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Drawing } from '@/components/chart/types'

interface DrawingStore {
  drawingsByMarket: Record<string, Drawing[]>
  selectedId: string | null

  getDrawings: (marketId: string) => Drawing[]
  addDrawing: (marketId: string, drawing: Drawing) => void
  updateDrawing: (marketId: string, id: string, updates: Partial<Drawing>) => void
  deleteDrawing: (marketId: string, id: string) => void
  deleteAll: (marketId: string) => void
  selectDrawing: (id: string | null) => void
  toggleLock: (marketId: string, id: string) => void
  toggleHide: (marketId: string, id: string) => void
}

export const useDrawingStore = create<DrawingStore>()(
  persist(
    (set, get) => ({
      drawingsByMarket: {},
      selectedId: null,

      getDrawings: (marketId) => get().drawingsByMarket[marketId] ?? [],

      addDrawing: (marketId, drawing) =>
        set(s => ({
          drawingsByMarket: {
            ...s.drawingsByMarket,
            [marketId]: [...(s.drawingsByMarket[marketId] ?? []), drawing],
          },
        })),

      updateDrawing: (marketId, id, updates) =>
        set(s => ({
          drawingsByMarket: {
            ...s.drawingsByMarket,
            [marketId]: (s.drawingsByMarket[marketId] ?? []).map(d =>
              d.id === id ? ({ ...d, ...updates } as Drawing) : d
            ),
          },
        })),

      deleteDrawing: (marketId, id) =>
        set(s => ({
          drawingsByMarket: {
            ...s.drawingsByMarket,
            [marketId]: (s.drawingsByMarket[marketId] ?? []).filter(d => d.id !== id),
          },
        })),

      deleteAll: (marketId) =>
        set(s => ({
          drawingsByMarket: { ...s.drawingsByMarket, [marketId]: [] },
        })),

      selectDrawing: (id) => set({ selectedId: id }),
      toggleLock: (marketId, id) =>
        set(s => ({
          drawingsByMarket: {
            ...s.drawingsByMarket,
            [marketId]: (s.drawingsByMarket[marketId] ?? []).map(d =>
              d.id === id ? ({ ...d, locked: !d.locked } as Drawing) : d
            ),
          },
        })),
      toggleHide: (marketId, id) =>
        set(s => ({
          drawingsByMarket: {
            ...s.drawingsByMarket,
            [marketId]: (s.drawingsByMarket[marketId] ?? []).map(d =>
              d.id === id ? ({ ...d, hidden: !d.hidden } as Drawing) : d
            ),
          },
        })),
    }),
    {
      name: 'kryon-drawings-v1',
      storage: createJSONStorage(() => localStorage),
    }
  )
)
