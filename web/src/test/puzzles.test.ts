import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Chess } from 'chess.js'

interface Puzzle {
  id: string
  fen: string
  moves: string
  rating: number
  themes: string[]
}

const PUZZLES_PATH = resolve(__dirname, '../../public/puzzles.json')
const puzzles: Puzzle[] = JSON.parse(readFileSync(PUZZLES_PATH, 'utf-8'))

describe('puzzles.json bundle', () => {
  it('has 1000 puzzles', () => {
    expect(puzzles.length).toBe(1000)
  })

  it('every puzzle has required fields', () => {
    for (const p of puzzles) {
      expect(p.id).toMatch(/^[A-Za-z0-9]+$/)
      expect(p.fen).toMatch(/^[rnbqkpRNBQKP1-8/]+ [wb] /)
      expect(p.moves.split(' ').length).toBeGreaterThanOrEqual(2)
      expect(p.rating).toBeGreaterThan(0)
      expect(p.themes.length).toBeGreaterThan(0)
    }
  })

  it('every solution move is legal from its predecessor', () => {
    for (const p of puzzles) {
      const chess = new Chess(p.fen)
      const ucis = p.moves.split(' ')
      for (const uci of ucis) {
        const from = uci.slice(0, 2)
        const to = uci.slice(2, 4)
        const promotion = uci.length > 4 ? uci[4] : undefined
        const move = chess.move({ from, to, promotion })
        expect(
          move,
          `Puzzle ${p.id}: move ${uci} from FEN ${chess.fen()} is not legal`,
        ).toBeTruthy()
      }
    }
  }, 30_000) // replays ~1000 puzzles; the 5s default times out on a busy machine

  it('covers all rating bands', () => {
    const bands = {
      beginner: puzzles.filter(p => p.rating < 1200).length,
      easy: puzzles.filter(p => p.rating >= 1200 && p.rating < 1500).length,
      medium: puzzles.filter(p => p.rating >= 1500 && p.rating < 1800).length,
      hard: puzzles.filter(p => p.rating >= 1800 && p.rating < 2100).length,
      expert: puzzles.filter(p => p.rating >= 2100).length,
    }
    expect(bands.beginner).toBeGreaterThan(0)
    expect(bands.easy).toBeGreaterThan(0)
    expect(bands.medium).toBeGreaterThan(0)
    expect(bands.hard).toBeGreaterThan(0)
    expect(bands.expert).toBeGreaterThan(0)
  })
})
