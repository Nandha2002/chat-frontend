import React, { useState } from 'react'
import FileUpload from './components/FileUpload.jsx'

// Injects scaffold-time values from Handlebars into runtime config.
const CONFIG = {
  pageTitle: "Demo",
  headline: "Head",
  primaryColor: "#ff8c00",
  secondaryColor: "#6ea8ff",
  chatbotName: "Bot",
  uploadLabel: "Upload",
  uploadHint: "Hint",
  welcomePrompts: [
    "One"
  ],
  acceptedFileTypes: [
    ".pdf"
  ],
  // RAG settings are captured at render time and available for backend/API wiring.
  ragConfig: {
    chunkSize: 800,
    embeddingModel: "my-custom-embed-model",
    searchMethod: "my-custom-search",
    systemPrompt: "Use context",
    llmChoice: "my-custom-llm",
    temperature: 0.4
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
