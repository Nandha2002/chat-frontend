# Frontend Creator

Frontend Creator is a local template rendering platform for generating chatbot frontends from configurable templates.

It includes:
- A Dashboard UI to choose a template, edit schema-based fields, and render outputs.
- A Node.js API server to serve dashboard/assets, render templates, and manage instances.
- A Handlebars-based renderer that validates values using JSON Schema (AJV).

## Features

- Template registry via `templates.json`
- Dynamic form generation from each template's `schema.json`
- Render output to `out/<project-name>`
- Instance metadata persisted per output in `.template-instance.json`
- Backend payload capture on render (template + configuration + render options)
- Backend payload history files (timestamped)
- Optional forwarding of backend payload to another API endpoint
- Same-folder re-render fallback on Windows lock issues

## Project Structure

```text
Frontend_Creator/
  api-server.js                    # Dashboard + API server
  renderer.js                      # Handlebars renderer CLI
  templates.json                   # Template registry
  dashboard/
    index.html
    app.js                         # Dashboard logic
    styles.css
  templates/
    Template_style1/
    Template_style2/
  out/                             # Generated projects
  .tmp/
    latest-backend-render-config.json
    backend-render-config-history/
```

## Requirements

- Node.js 18+ (ESM project)
- npm

## Install

```bash
npm install
```

## Run

Start API + dashboard server:

```bash
npm run api
```

Default URL:
- `http://127.0.0.1:3001/dashboard`

## Dashboard Flow

1. Open dashboard.
2. Select a template.
3. Fill configuration fields (including RAG fields).
4. Click `Render Template`.

When you click render, the dashboard does two calls:
1. `POST /backend/render-config` with full payload (template + config + render options)
2. `POST /render` to generate the project

## Render Output and Metadata

Each generated output folder contains:
- Rendered project files
- `.template-instance.json` with:
  - `templateId`
  - `values`
  - `createdAt`, `updatedAt`

This metadata powers the dashboard `Configure` action for existing chatbots.

## Backend Payload Persistence

On each dashboard render submit, backend payload is saved to:

- Latest snapshot (overwritten each time):
  - `.tmp/latest-backend-render-config.json`
- History (new file every submit):
  - `.tmp/backend-render-config-history/render-config-<timestamp>.json`

## API Endpoints

### Health
- `GET /health`

### Dashboard and static files
- `GET /`
- `GET /dashboard`
- `GET /dashboard/*`
- `GET /outputs/*`

### Templates and instances
- `GET /templates`
- `GET /templates/:id/schema`
- `GET /instances`
- `GET /instances/:name`

### Rendering
- `POST /render`

Request body:

```json
{
  "templateId": "Template_style2",
  "out": "my-chatbot",
  "open": true,
  "values": {
    "ragConfig": {
      "temperature": 0.4
    }
  }
}
```

### Backend config capture
- `POST /backend/render-config`
- `GET /backend/render-config/latest`

Capture request body shape:

```json
{
  "template": {
    "id": "Template_style2",
    "name": "Template_style2"
  },
  "configuration": {
    "ragConfig": {
      "temperature": 0.4
    }
  },
  "renderOptions": {
    "out": "my-chatbot",
    "open": true
  },
  "source": "dashboard-render-submit",
  "requestedAt": "2026-03-19T16:00:00.000Z"
}
```

## Optional Forwarding to External Backend

You can forward each `/backend/render-config` payload to another API by setting:

```bash
BACKEND_CONFIG_FORWARD_URL=https://your-backend/api/render-config
```

If not set, payload is still stored locally.

## Re-render Reliability (Windows)

If re-rendering to the same output folder fails due to transient file locks, server automatically retries once with a new suffixed folder:

- Requested: `out/my-chatbot`
- Fallback: `out/my-chatbot-<timestamp>`

Response includes:
- `fallbackUsed: true`
- `requestedOut`
- `outDir`

## Troubleshooting

### Port already in use
Error example: `EADDRINUSE 127.0.0.1:3001`

Options:
- Stop the process using port 3001, then run `npm run api`
- Or start on another port:

```powershell
$env:PORT=3010
npm run api
```

### Render fails after Configure + change + Render
This is usually a same-folder lock issue on Windows. The fallback retry logic now handles this automatically.

### Backend payload endpoint returns 404
Make sure you restarted the API after pulling latest changes.

## Notes

- `templates.json` currently contains two templates: `Template_style1` and `Template_style2`.
- Template descriptions in `templates.json` can be updated independently of template behavior.
