import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { Chess, type Square } from 'chess.js'
import { Board } from './Board.tsx'
import { MoveList } from './MoveList.tsx'
import { EvalBar } from './EvalBar.tsx'
import { PlayerRow } from './PlayerRow.tsx'
import { GameControls } from './GameControls.tsx'
import { DifficultyColorPicker } from './DifficultyColorPicker.tsx'
import { GameOverBanner } from './GameOverBanner.tsx'
import { GameSummary } from './GameSummary.tsx'
import { VoiceInstructions } from './VoiceInstructions.tsx'
import { findBestMove, evaluatePosition, findBestMoveSF, evaluatePositionSF, shouldUseStockfish } from '../services/engine.ts'
import { stockfish } from '../services/stockfish.ts'
import { analyzePlayerMove, describeMoveSpoken, getPositionAdvice } from '../services/analysis.ts'
import { parseVoiceMove } from '../services/voiceMoves.ts'
import { findOpening } from '../services/openings.ts'
import { buildPgn, copyToClipboard } from '../services/pgn.ts'
import { computeInitialPlayState, persistPlayState } from '../services/playPersistence.ts'
import { playSoundForMove } from '../services/sounds.ts'
import { speech } from '../services/speech.ts'
import { useSound } from '@freegamestore/games'
import { useSpeech } from '../hooks.ts'
import type { Settings } from '../services/settings.ts'
import type { Difficulty, MoveAnalysis, GameStatus } from '../types.ts'

interface PlayTabProps {
  settings: Settings
  updateSettings: (patch: Partial<Settings>) => void
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  1: 'Beginner',
  2: 'Easy',
  3: 'Stockfish',
  4: 'Stockfish+',
  5: 'Stockfish Max',
}

export function PlayTab({ settings, updateSettings }: PlayTabProps) {
  const { muted } = useSound()
  const [initial] = useState(() => computeInitialPlayState(settings.playerColor))
  const [chess] = useState(initial.chess)
  const [fen, setFen] = useState(initial.fen)
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(initial.lastMove)
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [analyses, setAnalyses] = useState<Record<number, MoveAnalysis>>(initial.analyses)
  const [alternativePreview, setAlternativePreview] = useState<{
    moveIndex: number
    fen: string
    bestFrom: Square
    bestTo: Square
  } | null>(null)
  // Review mode: null = live game, number = show position after move N
  const [reviewMoveIndex, setReviewMoveIndex] = useState<number | null>(null)
  const [coaching, setCoaching] = useState<string | null>(null)
  const [gameStatus, setGameStatus] = useState<GameStatus>(initial.gameStatus)
  const [thinking, setThinking] = useState(false)
  const [evaluation, setEvaluation] = useState(0)
  const [heardText, setHeardText] = useState('')
  const speechState = useSpeech()
  const [sfReady, setSfReady] = useState(false)
  const listeningRef = useRef(false)
  const voiceRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Bumped whenever the position is changed outside normal play (new game, undo)
  // so an engine search that was started on the old position is discarded.
  const positionGenRef = useRef(0)

  const playerColor = settings.playerColor
  const isPlayerTurn = chess.turn() === playerColor && gameStatus === 'playing'

  // Lazily load Stockfish when difficulty 3+
  useEffect(() => {
    if (settings.difficulty >= 3 && !stockfish.ready && !stockfish.failed) {
      stockfish.init().then((ok) => setSfReady(ok))
    }
  }, [settings.difficulty])

  // Evaluate position whenever it changes (skip while engine is thinking)
  useEffect(() => {
    if (thinking) return
    if (sfReady) {
      let cancelled = false
      evaluatePositionSF(chess).then(v => { if (!cancelled) setEvaluation(v) })
      return () => { cancelled = true }
    } else {
      setEvaluation(evaluatePosition(chess))
    }
  }, [fen, chess, sfReady, thinking])

  // Persist the game so a reload doesn't lose it. Clear storage on fresh game.
  useEffect(() => {
    persistPlayState({ chess, analyses, gameStatus, playerColor: settings.playerColor })
  }, [fen, analyses, gameStatus, settings.playerColor, chess])

  const updateGameStatus = useCallback(() => {
    if (chess.isCheckmate()) {
      const winner = chess.turn() === 'w' ? 'b' : 'w'
      setGameStatus('checkmate')
      const msg = winner === playerColor ? 'Checkmate! You win!' : "Checkmate. You lost."
      setCoaching(msg)
      if (!muted) speech.speak(msg)
    } else if (chess.isStalemate()) {
      setGameStatus('stalemate')
      const msg = "Stalemate! It's a draw."
      setCoaching(msg)
      if (!muted) speech.speak(msg)
    } else if (chess.isDraw()) {
      setGameStatus('draw')
      const msg = "Draw!"
      setCoaching(msg)
      if (!muted) speech.speak(msg)
    }
  }, [chess, playerColor, !muted])

  const makeEngineMove = useCallback(async () => {
    if (chess.isGameOver() || chess.turn() === playerColor) return

    const gen = positionGenRef.current
    setThinking(true)
    try {
      // Small delay so UI shows "Thinking..."
      await new Promise(r => setTimeout(r, 100))
      if (gen !== positionGenRef.current) return

      const useSF = shouldUseStockfish(settings.difficulty)
      const move = useSF
        ? await findBestMoveSF(chess, settings.difficulty)
        : findBestMove(chess, settings.difficulty)

      // The board was reset or undone while searching: this move is for a stale position.
      if (!move || gen !== positionGenRef.current) return

      const played = chess.move(move)
      setFen(chess.fen())
      setLastMove({ from: move.from, to: move.to })
      setSelectedSquare(null)
      playSoundForMove(played, muted)

      const desc = describeMoveSpoken(move.san, chess.turn() === 'w' ? 'b' : 'w')
      if (!muted) speech.speak(desc)

      const advice = getPositionAdvice(chess, playerColor)
      if (advice && settings.showCoaching) setCoaching(advice)

      updateGameStatus()
    } finally {
      setThinking(false)
    }
  }, [chess, playerColor, settings.difficulty, !muted, settings.showCoaching, updateGameStatus])

  // After state change, check if engine should move
  useEffect(() => {
    if (gameStatus !== 'playing') return
    if (chess.turn() !== playerColor && !thinking) {
      const timer = setTimeout(makeEngineMove, 300)
      return () => clearTimeout(timer)
    }
  }, [fen, gameStatus, chess, playerColor, thinking, makeEngineMove])

  const handleMove = useCallback((from: Square, to: Square, promotion?: string): boolean => {
    if (!isPlayerTurn) return false

    const moveBefore = chess.fen()
    try {
      const move = chess.move({ from, to, promotion })
      if (!move) return false

      const moveIndex = chess.history().length - 1
      setFen(chess.fen())
      setLastMove({ from, to })
      setSelectedSquare(null)
      setAlternativePreview(null)
      playSoundForMove(move, muted)
      updateGameStatus()

      // Analyze async (don't block the move)
      if (settings.showCoaching) {
        const tempChess = new Chess(moveBefore)
        analyzePlayerMove(tempChess, move.san, playerColor, settings.difficulty).then(analysis => {
          setAnalyses(prev => ({ ...prev, [moveIndex]: analysis }))
          if (analysis.category !== 'good' && !muted) {
            speech.speak(analysis.explanation)
          }
        })
      }

      return true
    } catch {
      return false
    }
  }, [chess, isPlayerTurn, playerColor, settings.showCoaching, !muted, settings.difficulty, updateGameStatus])

  const resetGame = useCallback(() => {
    positionGenRef.current++
    chess.reset()
    setFen(chess.fen())
    setLastMove(null)
    setSelectedSquare(null)
    setAnalyses({})
    setAlternativePreview(null)
    setCoaching(null)
    setGameStatus('playing')
    setEvaluation(0)
    setHeardText('')
    if (!muted) speech.speak('New game started.')
  }, [chess, !muted])

  // Roll back the most recent player + engine move pair. Returns true if anything was undone.
  const undoMovePair = useCallback(() => {
    const lenBefore = chess.history().length
    if (lenBefore < 2) return false
    positionGenRef.current++
    chess.undo()
    chess.undo()
    setFen(chess.fen())
    setLastMove(null)
    setSelectedSquare(null)
    setAnalyses(prev => {
      const next = { ...prev }
      delete next[lenBefore - 1]
      delete next[lenBefore - 2]
      return next
    })
    return true
  }, [chess])

  // Voice control
  const startVoiceListening = useCallback(() => {
    if (listeningRef.current) return
    listeningRef.current = true

    speech.startListening('en-US', (text) => {
      setHeardText(text)
      const moveStr = parseVoiceMove(text, chess)

      if (moveStr === '__undo__') {
        // Undo both player and engine moves
        if (undoMovePair()) {
          setCoaching('Took back the last move.')
          if (!muted) speech.speak('Move taken back.')
        }
        return
      }

      if (moveStr === '__resign__') {
        setGameStatus('resigned')
        setCoaching('You resigned.')
        if (!muted) speech.speak('You resigned.')
        return
      }

      if (moveStr === '__new_game__') {
        resetGame()
        return
      }

      if (moveStr && isPlayerTurn) {
        // Find the move object from legal moves
        const legalMoves = chess.moves({ verbose: true })
        const matchedMove = legalMoves.find(m => m.san === moveStr)
        if (matchedMove) {
          handleMove(matchedMove.from, matchedMove.to, matchedMove.promotion)
          if (!muted && !settings.showCoaching) {
            const desc = describeMoveSpoken(moveStr, playerColor)
            speech.speak(desc)
          }
        }
      } else if (!moveStr) {
        setCoaching(`Didn't understand "${text}". Try saying a move like "e4" or "knight f3".`)
      }
    }, {
      continuous: true,
      interimResults: true,
      onInterim: (text) => setHeardText(text),
      onEnd: () => {
        listeningRef.current = false
        // Auto-restart if mic is still on
        if (settings.microphone && gameStatus === 'playing') {
          voiceRestartRef.current = setTimeout(() => {
            startVoiceListening()
          }, 200)
        }
      },
    })
  }, [chess, isPlayerTurn, playerColor, !muted, settings.showCoaching, settings.microphone, gameStatus, handleMove, resetGame, undoMovePair])

  // Start/stop voice listening when microphone setting changes
  useEffect(() => {
    if (settings.microphone && gameStatus === 'playing') {
      startVoiceListening()
    } else {
      speech.stopListening()
      listeningRef.current = false
      if (voiceRestartRef.current) {
        clearTimeout(voiceRestartRef.current)
        voiceRestartRef.current = null
      }
    }
    return () => {
      if (voiceRestartRef.current) {
        clearTimeout(voiceRestartRef.current)
        voiceRestartRef.current = null
      }
    }
  }, [settings.microphone, gameStatus, startVoiceListening])

  const handleUndo = useCallback(() => {
    if (undoMovePair()) {
      setCoaching(null)
      setGameStatus('playing')
    }
  }, [undoMovePair])

  const handleResign = useCallback(() => {
    if (gameStatus !== 'playing') return
    setGameStatus('resigned')
    setCoaching('You resigned.')
    if (!muted) speech.speak('You resigned.')
  }, [gameStatus, !muted])

  const [hintArrow, setHintArrow] = useState<{ from: Square; to: Square } | null>(null)
  const [hintLoading, setHintLoading] = useState(false)
  const requestHint = useCallback(async () => {
    if (!isPlayerTurn || hintLoading) return
    setHintLoading(true)
    const gen = positionGenRef.current
    try {
      // Prefer Stockfish for stronger hints; fall back to minimax.
      const move = sfReady
        ? await findBestMoveSF(chess, Math.max(settings.difficulty, 3) as Difficulty)
        : findBestMove(chess, Math.max(settings.difficulty, 2) as Difficulty)
      if (move && gen === positionGenRef.current) setHintArrow({ from: move.from, to: move.to })
    } finally {
      setHintLoading(false)
    }
  }, [chess, isPlayerTurn, hintLoading, sfReady, settings.difficulty])

  // Any change in board position clears the hint arrow.
  useEffect(() => { setHintArrow(null) }, [fen])

  const flipBoard = useCallback(() => {
    updateSettings({ boardFlipped: !settings.boardFlipped })
  }, [settings.boardFlipped, updateSettings])

  const history = chess.history()
  const boardFlipped = settings.boardFlipped !== (playerColor === 'b')
  const opening = useMemo(() => findOpening(history), [history.join(' ')])
  const [pgnCopied, setPgnCopied] = useState(false)
  const exportPgn = useCallback(async () => {
    const result =
      chess.isCheckmate() ? (chess.turn() === 'w' ? '0-1' : '1-0')
      : (chess.isStalemate() || chess.isDraw()) ? '1/2-1/2'
      : '*'
    const pgn = buildPgn(chess, {
      event: `Chess vs ${DIFFICULTY_LABELS[settings.difficulty]}`,
      white: playerColor === 'w' ? 'You' : `Engine (${DIFFICULTY_LABELS[settings.difficulty]})`,
      black: playerColor === 'b' ? 'You' : `Engine (${DIFFICULTY_LABELS[settings.difficulty]})`,
      result,
    })
    const ok = await copyToClipboard(pgn)
    if (ok) {
      setPgnCopied(true)
      setTimeout(() => setPgnCopied(false), 1500)
    }
  }, [chess, settings.difficulty, playerColor])

  // Review-mode helpers: compute the position after a given move index
  const reviewFen = useMemo(() => {
    if (reviewMoveIndex === null) return null
    const replay = new Chess()
    const moves = chess.history({ verbose: true })
    for (let k = 0; k <= reviewMoveIndex && k < moves.length; k++) {
      replay.move(moves[k])
    }
    return replay.fen()
  }, [reviewMoveIndex, chess, fen])

  const reviewLastMove = useMemo(() => {
    if (reviewMoveIndex === null) return null
    const moves = chess.history({ verbose: true })
    const m = moves[reviewMoveIndex]
    return m ? { from: m.from as Square, to: m.to as Square } : null
  }, [reviewMoveIndex, chess, fen])

  const inReview = reviewMoveIndex !== null
  const exitReview = useCallback(() => setReviewMoveIndex(null), [])
  const prevReview = useCallback(() => {
    setReviewMoveIndex(i => i === null ? history.length - 1 : Math.max(0, i - 1))
  }, [history.length])
  const nextReview = useCallback(() => {
    setReviewMoveIndex(i => {
      if (i === null || i >= history.length - 1) return null
      return i + 1
    })
  }, [history.length])

  // Keyboard nav: arrow keys step through review mode; Escape exits review.
  useEffect(() => {
    if (history.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); prevReview() }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nextReview() }
      else if (e.key === 'Escape' && inReview) { e.preventDefault(); exitReview() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history.length, inReview, prevReview, nextReview, exitReview])

  const opponentBadge = thinking
    ? <span className="ml-auto text-xs text-[var(--muted)] animate-pulse">Thinking...</span>
    : undefined

  const playerBadge = (
    <>
      {isPlayerTurn && !thinking && (
        <span className="ml-1 rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider text-[var(--success)]">
          Your turn
        </span>
      )}
      {settings.microphone && (
        <div className="ml-2 flex items-center gap-1">
          <div className={`h-2 w-2 rounded-full ${speechState.isListening ? 'bg-[var(--success)] pulse-ring' : 'bg-[var(--muted)]'}`} />
          <span className="text-xs text-[var(--muted)]">
            {speechState.isListening ? 'Listening' : 'Mic on'}
          </span>
        </div>
      )}
    </>
  )

  return (
    <div className="flex flex-col gap-1 landscape:flex-row landscape:gap-3 lg:flex-row lg:gap-6 h-full overflow-hidden">
      {/* Board area */}
      <div className="flex flex-col gap-1 lg:gap-2 landscape:w-[min(55%,560px)] lg:w-[min(60%,560px)] min-h-0 shrink-0">
        <PlayerRow
          variant="opponent"
          kingGlyph={playerColor === 'w' ? '\u265A' : '\u2654'}
          label={`Engine (${DIFFICULTY_LABELS[settings.difficulty]})`}
          right={opponentBadge}
        />

        <div className="flex gap-1.5">
          {settings.showEvalBar && <EvalBar evaluation={evaluation} />}
          <div className="flex-1 min-w-0">
            <Board
              chess={chess}
              flipped={boardFlipped}
              playerColor={playerColor}
              onMove={handleMove}
              lastMove={inReview ? reviewLastMove : lastMove}
              selectedSquare={(inReview || alternativePreview) ? null : selectedSquare}
              onSquareClick={(sq) => { setAlternativePreview(null); setSelectedSquare(sq) }}
              previewFen={inReview ? reviewFen : (alternativePreview?.fen ?? null)}
              previewArrow={alternativePreview && !inReview ? { from: alternativePreview.bestFrom, to: alternativePreview.bestTo } : null}
              previewLabel={inReview ? `Move ${Math.floor((reviewMoveIndex ?? 0) / 2) + 1}${(reviewMoveIndex ?? 0) % 2 === 0 ? '' : '...'}` : 'Best alternative'}
              liveArrow={!inReview && !alternativePreview ? hintArrow : null}
            />
          </div>
        </div>

        <PlayerRow
          variant="player"
          kingGlyph={playerColor === 'w' ? '\u2654' : '\u265A'}
          label="You"
          right={playerBadge}
        />

        {settings.microphone && heardText && (
          <div className="rounded-[0.75rem] border border-[var(--line)] bg-[var(--glass-soft)] px-3 py-2 text-sm text-[var(--muted)]">
            Heard: "{heardText}"
          </div>
        )}
      </div>

      {/* Sidebar: moves, coaching, controls */}
      <div className="flex flex-col gap-1.5 lg:gap-3 flex-1 lg:min-w-[240px] min-h-0 min-w-0 overflow-y-auto">
        <GameControls
          onNewGame={resetGame}
          onUndo={handleUndo}
          canUndo={history.length >= 2}
          onFlip={flipBoard}
          onResign={handleResign}
          canResign={gameStatus === 'playing' && history.length > 0}
          onHint={requestHint}
          canHint={isPlayerTurn}
          hintLoading={hintLoading}
          microphoneOn={settings.microphone}
          onToggleMic={() => updateSettings({ microphone: !settings.microphone })}
        />

        <DifficultyColorPicker
          difficulty={settings.difficulty}
          onDifficultyChange={(d) => updateSettings({ difficulty: d })}
          playerColor={playerColor}
          onColorChange={(c) => { updateSettings({ playerColor: c, boardFlipped: false }); resetGame() }}
        />

        {coaching && gameStatus === 'playing' && (
          <div className="rounded-[0.75rem] border border-[var(--line)] bg-[var(--glass-soft)] px-3 py-2 text-sm text-[var(--ink)]">
            {coaching}
          </div>
        )}

        <GameOverBanner
          status={gameStatus}
          playerLost={chess.turn() === playerColor}
          onPlayAgain={resetGame}
        />

        {gameStatus !== 'playing' && Object.keys(analyses).length > 0 && (
          <GameSummary
            analyses={analyses}
            history={history}
            playerColor={playerColor}
            onReviewMove={(idx) => setReviewMoveIndex(idx)}
          />
        )}

        {gameStatus !== 'playing' && history.length > 0 && (
          <button
            type="button"
            onClick={exportPgn}
            className="rounded-[0.75rem] border border-[var(--line)] bg-[var(--glass)] px-3 py-2 text-xs font-semibold text-[var(--muted)] hover:bg-[var(--glass-hover)] hover:text-[var(--ink)]"
          >
            {pgnCopied ? 'PGN copied ✓' : 'Copy PGN'}
          </button>
        )}

        <div className="rounded-[1rem] border border-[var(--line)] bg-[var(--glass-soft)] p-3">
          {opening && (
            <div className="mb-2 flex items-baseline gap-2 border-b border-[var(--line)] pb-2">
              <span className="text-[0.6rem] font-bold uppercase tracking-[0.15em] text-[var(--muted)]">Opening</span>
              <span className="text-xs font-semibold text-[var(--ink)]">{opening}</span>
            </div>
          )}
          <div className="mb-2 flex items-center justify-between">
            <div className="text-[0.6rem] font-bold uppercase tracking-[0.15em] text-[var(--muted)]">
              {inReview ? `Reviewing move ${Math.floor((reviewMoveIndex ?? 0) / 2) + 1}${(reviewMoveIndex ?? 0) % 2 === 0 ? ' (white)' : ' (black)'}` : 'Moves'}
            </div>
            {history.length > 0 && (
              <div className="flex gap-0.5">
                <button
                  type="button"
                  onClick={prevReview}
                  disabled={reviewMoveIndex === 0}
                  className="rounded-[0.25rem] border border-[var(--line)] bg-[var(--glass)] px-2 py-0.5 text-xs font-mono text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-30"
                  title="Previous move"
                >‹</button>
                <button
                  type="button"
                  onClick={nextReview}
                  disabled={!inReview}
                  className="rounded-[0.25rem] border border-[var(--line)] bg-[var(--glass)] px-2 py-0.5 text-xs font-mono text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-30"
                  title="Next move"
                >›</button>
                {inReview && (
                  <button
                    type="button"
                    onClick={exitReview}
                    className="rounded-[0.25rem] border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent)]/20"
                    title="Exit review, return to live game"
                  >Live</button>
                )}
              </div>
            )}
          </div>
          <MoveList
            history={history}
            analyses={analyses}
            activeAlternative={alternativePreview?.moveIndex ?? null}
            activeReviewMove={reviewMoveIndex}
            onJumpToMove={(idx) => { setAlternativePreview(null); setReviewMoveIndex(idx) }}
            onShowAlternative={(moveIndex, analysis) => {
              if (alternativePreview?.moveIndex === moveIndex) {
                setAlternativePreview(null)
                return
              }
              if (!analysis.bestMove || analysis.bestMove === analysis.move) return
              const replay = new Chess()
              const moves = chess.history({ verbose: true })
              for (let i = 0; i < moveIndex; i++) {
                replay.move(moves[i])
              }
              const legal = replay.moves({ verbose: true })
              const best = legal.find(m => m.san === analysis.bestMove)
              if (best) {
                replay.move(best)
                setAlternativePreview({
                  moveIndex,
                  fen: replay.fen(),
                  bestFrom: best.from,
                  bestTo: best.to,
                })
              }
            }}
          />
        </div>

        {settings.microphone && <VoiceInstructions />}
      </div>
    </div>
  )
}
