import React, { useRef, useState, useEffect } from 'react'
import PredefinedQuestions from './PredefinedQuestions.jsx'

// Icon used by the send button in the composer.
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 11.5 20.45 4.3c.66-.27 1.3.37 1.03 1.03L14.28 22.8c-.28.68-1.25.63-1.46-.08l-2.02-6.94-6.94-2.02c-.71-.21-.76-1.18-.08-1.46Z" fill="currentColor" />
    </svg>
  )
}

// Chat workspace with starter prompts, conversation view, composer controls, and RAG debug data.
export default function Chat({ appName, messages, onSend, onReset, questions, placeholder, showTimestamps, ragConfig }) {
  const [input, setInput] = useState('')
  const [fontScale, setFontScale] = useState(1)
  const endRef = useRef(null)
  const hasMessages = messages.length > 0
  // Chooses a CSS class to scale message text.
  const scaleClass = fontScale <= 0.9 ? 'scale-sm' : fontScale >= 1.15 ? 'scale-lg' : 'scale-md'

  // Keeps the latest message visible when new messages arrive.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Sends on Enter and allows Shift+Enter for new lines.
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(input)
      setInput('')
    }
  }

  // Sends the current input if non-empty.
  const submit = () => {
    if (!input.trim()) return
    onSend(input)
    setInput('')
  }

  // Decreases text size with lower bound.
  const decreaseFont = () => {
    setFontScale((v) => Math.max(0.85, Number((v - 0.05).toFixed(2))))
  }

  // Increases text size with upper bound.
  const increaseFont = () => {
    setFontScale((v) => Math.min(1.3, Number((v + 0.05).toFixed(2))))
  }

  // Exports conversation to a plain-text transcript file.
  const downloadTranscript = () => {
    if (!messages.length) return
    const lines = messages.map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : 'You'
      const ts = m.ts ? ` (${new Date(m.ts).toLocaleString()})` : ''
      return `${role}${ts}: ${m.content}`
    })

    const payload = lines.join('\n\n')
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${appName.replace(/\s+/g, '-').toLowerCase()}-chat.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="chat-shell">
      <div className={`chat-stage ${hasMessages ? 'chat-stage--active' : 'chat-stage--idle'}`}>
        {!hasMessages ? (
          <PredefinedQuestions
            appName={appName}
            questions={questions}
            onChoose={onSend}
          />
        ) : (
          <div className={`messages-wrap ${scaleClass}`}>
            <div className="conversation-head">
              <div>
                <p className="conversation-label">Conversation</p>
                <h2>{appName}</h2>
              </div>
              <button type="button" className="text-action" onClick={onReset}>Start over</button>
            </div>

            <div className="messages">
              {messages.map((m, i) => (
                <div key={i} className={`msg ${m.role}`}>
                  <div className="bubble">
                    <div className="content">{m.content}</div>
                    {showTimestamps && m.ts && (
                      <div className="meta">{new Date(m.ts).toLocaleTimeString()}</div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
          </div>
        )}
      </div>

      <div className="bottom-tools">
        <button type="button" className="tool-btn" onClick={decreaseFont} aria-label="Decrease message size">-</button>
        <button type="button" className="tool-btn" onClick={increaseFont} aria-label="Increase message size">+</button>
        <button
          type="button"
          className="tool-btn"
          onClick={downloadTranscript}
          aria-label="Download conversation"
          disabled={!messages.length}
        >
          ↓
        </button>
      </div>

      <div className="composer-dock">
        <div className="composer">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={placeholder}
            rows={1}
          />
          <button type="button" className="send-btn" onClick={submit} aria-label="Send message">
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  )
}
