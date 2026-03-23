import React, { useRef } from 'react'

// Landing screen for file upload and suggested starter prompts.
export default function LandingPage({
  headline,
  primaryColor,
  secondaryColor,
  chatbotName,
  uploadLabel,
  uploadHint,
  welcomePrompts,
  acceptedFileTypes,
  onFileSelect
}) {
  const fileInputRef = useRef(null)

  // Handles file selection from the hidden file input.
  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      onFileSelect(file)
    }
  }

  // Handles drag-and-drop file upload with extension filtering.
  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.dataTransfer.files?.[0]
    if (file && acceptedFileTypes.some(ext => file.name.endsWith(ext))) {
      onFileSelect(file)
    }
  }

  // Placeholder action for starter prompts before backend wiring.
  const handlePromptClick = (prompt) => {
    // In a real app, this would initialize the chat with the prompt
    console.log('Prompt selected:', prompt)
  }

  return (
    <div className="landing-shell">
      <div className="landing-panel">
        <h1 className="landing-headline">{headline}</h1>
        <p className="landing-subtext">Upload your document to get started with {chatbotName}</p>

        <div
          className="upload-area"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="upload-icon">📄</div>
          <span className="upload-label">{uploadLabel}</span>
          <span className="upload-hint">{uploadHint}</span>
          <button type="button" className="upload-action">
            Choose File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={acceptedFileTypes.join(',')}
            onChange={handleFileChange}
          />
        </div>

        {welcomePrompts && welcomePrompts.length > 0 && (
          <div className="prompts-section">
            <span className="prompts-label">Or try these:</span>
            <div className="prompts-grid">
              {welcomePrompts.map((prompt, idx) => (
                <button
                  key={idx}
                  type="button"
                  className="prompt-card"
                  onClick={() => handlePromptClick(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
