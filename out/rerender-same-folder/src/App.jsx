import React, { useState } from 'react'
import FileUpload from './components/FileUpload.jsx'

// Injects scaffold-time values from Handlebars into runtime config.
const CONFIG = {
  pageTitle: "Demo",
  headline: "H",
  primaryColor: "#148c67",
  secondaryColor: "#d9d9d9",
  chatbotName: "Bot",
  uploadLabel: "Upload",
  uploadHint: "hint",
  welcomePrompts: [
    "a"
  ],
  acceptedFileTypes: [
    ".pdf"
  ],
  // RAG settings are captured at render time and available for backend/API wiring.
  ragConfig: {
    chunkSize: 800,
    embeddingModel: "text-embedding-3-small",
    searchMethod: "hybrid",
    systemPrompt: "x",
    llmChoice: "gpt-4o-mini",
    temperature: 0.1
  }
}

// Main shell for chat-first flow with optional document upload.
export default function App() {
  const [uploadedFile, setUploadedFile] = useState(null)

  // Stores the selected document for context-aware answers.
  const handleFileUpload = (file) => {
    setUploadedFile(file)
  }

  return (
    <div className="app-container">
      <FileUpload
        file={uploadedFile}
        chatbotName={CONFIG.chatbotName}
        primaryColor={CONFIG.primaryColor}
        secondaryColor={CONFIG.secondaryColor}
        ragConfig={CONFIG.ragConfig}
        uploadLabel={CONFIG.uploadLabel}
        uploadHint={CONFIG.uploadHint}
        acceptedFileTypes={CONFIG.acceptedFileTypes}
        onFileSelect={handleFileUpload}
      />
    </div>
  )
}
