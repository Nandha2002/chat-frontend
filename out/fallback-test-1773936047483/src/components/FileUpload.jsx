import React, { useState, useRef, useEffect } from 'react'

// Icon used by the send button in the chat composer.
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 11.5 20.45 4.3c.66-.27 1.3.37 1.03 1.03L14.28 22.8c-.28.68-1.25.63-1.46-.08l-2.02-6.94-6.94-2.02c-.71-.21-.76-1.18-.08-1.46Z" fill="currentColor" />
    </svg>
  )
}

// Theme toggle icon
function ThemeIcon({ isDark }) {
  return isDark ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="5" fill="currentColor" />
      <path d="M12 1v6m0 6v6M4.22 4.22l4.24 4.24m2.98 2.98l4.24 4.24M1 12h6m6 0h6M4.22 19.78l4.24-4.24m2.98-2.98l4.24-4.24M19.78 19.78l-4.24-4.24m-2.98-2.98l-4.24-4.24" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor" />
    </svg>
  )
}

// Chat-first view with optional document upload for additional context.
export default function FileUpload({ file, chatbotName, primaryColor, secondaryColor, ragConfig, uploadLabel, uploadHint, acceptedFileTypes, onFileSelect }) {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content: `Hi! I'm ${chatbotName}. I've reviewed your document. What would you like to know about it?`,
      ts: new Date().toISOString()
    }
  ])
  const [input, setInput] = useState('')
  const [isDarkMode, setIsDarkMode] = useState(false)
  const fileInputRef = useRef(null)
  const endRef = useRef(null)

  // Keeps latest message visible as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Sends user input and appends a simulated assistant response.
  const handleSend = () => {
    if (!input.trim()) return

    const userMessage = {
      role: 'user',
      content: input,
      ts: new Date().toISOString()
    }

    setMessages(m => [...m, userMessage])

    // Simulate assistant response
    setTimeout(() => {
      const assistantMessage = {
        role: 'assistant',
        content: `Based on your question about "${input}", here's what I found in your document: [This is a demo response. In a real implementation, this would call your backend API.]`,
        ts: new Date().toISOString()
      }
      setMessages(m => [...m, assistantMessage])
    }, 500)

    setInput('')
  }

  // Sends on Enter and allows Shift+Enter for new lines.
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleFileChange = (e) => {
    const nextFile = e.target.files?.[0]
    if (nextFile && typeof onFileSelect === 'function') {
      onFileSelect(nextFile)
    }
  }

  const toggleTheme = () => setIsDarkMode(!isDarkMode)

  return (
    <div className={`chat-shell ${isDarkMode ? 'dark-mode' : ''}`}>
      <header className="chat-header">
        <button type="button" className="home-btn" onClick={() => window.location.href = '/'} title="Back to Dashboard">
          🏠 Home
        </button>
        <h1 className="chat-title">{chatbotName}</h1>
        <button
          type="button"
          className="theme-toggle-btn"
          onClick={toggleTheme}
          title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          <ThemeIcon isDark={isDarkMode} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={(acceptedFileTypes || []).join(',')}
          onChange={handleFileChange}
          hidden
        />
      </header>

      <div className="chat-content">
        {file && (
          <div className="file-info">
            <div className="file-info-label">📎 Document</div>
            <p className="file-info-name">{file.name}</p>
            {uploadHint ? <p className="file-info-name">{uploadHint}</p> : null}
          </div>
        )}

        <div className="messages">
          {messages.map((msg, idx) => (
            <div key={idx} className={`msg ${msg.role}`}>
              <div className="bubble">
                {msg.content}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>

      <div className="composer-dock">
        <div className="composer">
          <button
            type="button"
            className="upload-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Upload document"
            aria-label="Upload document"
          >
            +
          </button>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question about your document..."
            rows={1}
          />
          <button
            type="button"
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim()}
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  )
}
