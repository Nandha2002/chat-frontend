import React, { useState } from 'react'
import NavBar from './components/NavBar.jsx'
import Chat from './components/Chat.jsx'

// Injects scaffold-time values from Handlebars into runtime config.
const CONFIG = {
  appName: "My Chat",
  primaryColor: "orange",
  accentColor: "#1e90ff",
  logoPath: "/src/assets/logo.svg",
  links: [
    { label: "Home", href: "/" },
    { label: "Docs", href: "#" }
  ],
  predefinedQuestions: [
    "What can you do?",
    "Summarize the latest updates.",
    "Help me write an email."
  ],
  chatOptions: {
    placeholder: "Type a message…",
    showTimestamps: true
  },
  // RAG settings are captured at render time and available for backend/API wiring.
  ragConfig: {
    chunkSize: 800,
    embeddingModel: "text-embedding-3-small",
    searchMethod: "hybrid",
    systemPrompt: "You are a helpful assistant. Use retrieved context first and cite relevant information when possible.",
    llmChoice: "gpt-4.1",
    temperature: 0.2
  }
}

// Main shell component for chat experience and theme state.
export default function App() {
  const [theme, setTheme] = useState("dark")
  const [messages, setMessages] = useState([])

  // Toggles between dark and light UI modes.
  const toggleTheme = () => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }

  // Clears current conversation history.
  const resetConversation = () => {
    setMessages([])
  }

  // Adds a user message and a simple assistant echo response.
  const sendMessage = (text) => {
    if (!text.trim()) return
    const now = new Date()
    setMessages(m => [
      ...m,
      { role: 'user', content: text, ts: now.toISOString() },
      {
        role: 'assistant',
        content: `I can help with that. Here is a starting point for "${text}".`,
        ts: now.toISOString()
      }
    ])
  }

  return (
    <div className="app-shell" data-theme={theme}>
      <NavBar
        appName={CONFIG.appName}
        logoPath={CONFIG.logoPath}
        links={CONFIG.links}
        theme={theme}
        onToggleTheme={toggleTheme}
        onReset={resetConversation}
      />
      <main className="workspace">
        <section className="experience-panel">
          <Chat
            appName={CONFIG.appName}
            messages={messages}
            onSend={sendMessage}
            onReset={resetConversation}
            questions={CONFIG.predefinedQuestions}
            placeholder={CONFIG.chatOptions.placeholder}
            showTimestamps={CONFIG.chatOptions.showTimestamps}
            ragConfig={CONFIG.ragConfig}
          />
        </section>
      </main>
    </div>
  )
}
