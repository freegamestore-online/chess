export type SpeechState = {
  isListening: boolean
  transcript: string
  isSpeaking: boolean
  error: string | null
}

type Listener = () => void
type ListenOptions = {
  continuous?: boolean
  interimResults?: boolean
  onStart?: () => void
  onInterim?: (text: string) => void
  onEnd?: () => void
  onError?: (error: string) => void
}

class SpeechService {
  private listeners: Listener[] = []
  private recognition: SpeechRecognition | null = null
  // Undefined in browsers/webviews without Web Speech synthesis; speaking is then a no-op.
  private synthesis: SpeechSynthesis | undefined = window.speechSynthesis
  private voicesLoaded = false

  state: SpeechState = {
    isListening: false,
    transcript: '',
    isSpeaking: false,
    error: null,
  }

  constructor() {
    if (!this.synthesis) return
    if (this.synthesis.getVoices().length > 0) {
      this.voicesLoaded = true
    } else {
      this.synthesis.addEventListener('voiceschanged', () => {
        this.voicesLoaded = true
      }, { once: true })
    }
  }

  subscribe(fn: Listener) {
    this.listeners.push(fn)
    return () => { this.listeners = this.listeners.filter(l => l !== fn) }
  }

  private notify() {
    this.state = { ...this.state }
    this.listeners.forEach(fn => fn())
  }

  startListening(lang: string, onResult: (text: string) => void, options: ListenOptions = {}) {
    this.stopListening()

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      this.state.error = 'Speech recognition not supported'
      this.notify()
      options.onError?.(this.state.error)
      return
    }

    this.recognition = new SR()
    this.recognition.lang = lang
    this.recognition.interimResults = options.interimResults ?? true
    this.recognition.continuous = options.continuous ?? false

    this.recognition.onstart = () => {
      this.state.isListening = true
      this.state.transcript = ''
      this.state.error = null
      this.notify()
      options.onStart?.()
    }

    this.recognition.onresult = (e) => {
      let final = ''
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const sentence = e.results[i]
        if (sentence.isFinal) {
          final += sentence[0].transcript
        } else {
          interim += sentence[0].transcript
        }
      }
      this.state.transcript = final || interim
      this.notify()
      if (interim) options.onInterim?.(interim)
      if (final) onResult(final.trim())
    }

    this.recognition.onerror = (e) => {
      if (e.error !== 'aborted') {
        this.state.error = e.error
      }
      this.state.isListening = false
      this.notify()
      options.onError?.(e.error)
    }

    this.recognition.onend = () => {
      this.state.isListening = false
      this.notify()
      options.onEnd?.()
    }

    this.recognition.start()
  }

  stopListening() {
    if (this.recognition) {
      this.recognition.stop()
    }
  }

  speak(text: string, lang = 'en-US'): Promise<void> {
    const synthesis = this.synthesis
    if (!synthesis) return Promise.resolve()
    const doSpeak = () => new Promise<void>((resolve) => {
      synthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = lang
      utterance.rate = 0.9

      const voices = synthesis.getVoices()
      const match = voices.find(v => v.lang.startsWith(lang))
      if (match) utterance.voice = match

      utterance.onstart = () => {
        this.state.isSpeaking = true
        this.notify()
      }
      utterance.onend = () => {
        this.state.isSpeaking = false
        this.notify()
        resolve()
      }
      utterance.onerror = () => {
        this.state.isSpeaking = false
        this.notify()
        resolve()
      }

      synthesis.speak(utterance)
    })

    if (!this.voicesLoaded) {
      return new Promise<void>((resolve) => {
        synthesis.addEventListener('voiceschanged', () => {
          this.voicesLoaded = true
          doSpeak().then(resolve)
        }, { once: true })
      })
    }
    return doSpeak()
  }

  stopSpeaking() {
    this.synthesis?.cancel()
    this.state.isSpeaking = false
    this.notify()
  }
}

export const speech = new SpeechService()
