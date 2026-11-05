import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { Chess } from 'chess.js'
import { PlayTab } from '../components/PlayTab.tsx'
import { loadSettings } from '../services/settings.ts'
import { SAVE_KEY } from '../services/playPersistence.ts'

// The first engine search simulates the player pressing Undo mid-search and then
// returns a move for the old position (Qe7 is illegal once e7 is occupied again).
const engine = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../services/engine.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/engine.ts')>()
  return {
    ...actual,
    findBestMove: (chess: Chess, difficulty: Parameters<typeof actual.findBestMove>[1]) => {
      if (engine.calls++ > 0) return actual.findBestMove(chess, difficulty)
      const stale = chess.moves({ verbose: true }).find(m => m.san === 'Qe7')!
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
      return stale
    },
  }
})

// jsdom has no scrollIntoView (MoveList auto-scrolls)
Element.prototype.scrollIntoView = () => {}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('engine move after undo during search', () => {
  it('discards the stale move instead of freezing', async () => {
    const saved = new Chess()
    for (const m of ['e4', 'e5', 'Nf3']) saved.move(m)
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      pgn: saved.pgn(), analyses: {}, gameStatus: 'playing', playerColor: 'w', savedAt: 0,
    }))
    const settings = { ...loadSettings(), difficulty: 1 as const, playerColor: 'w' as const, showCoaching: false }

    render(<PlayTab settings={settings} updateSettings={() => {}} />)

    // Undo took the game back to 1. e4; the engine must reply to that position.
    await waitFor(() => {
      const pgn = JSON.parse(localStorage.getItem(SAVE_KEY)!).pgn as string
      const replay = new Chess()
      replay.loadPgn(pgn)
      expect(replay.history()).toHaveLength(2)
      expect(replay.history()[0]).toBe('e4')
    }, { timeout: 3000 })
    expect(engine.calls).toBe(2)
    expect(screen.queryByText('Thinking...')).toBeNull()
  })
})
