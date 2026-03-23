#!/usr/bin/env node
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'fs-extra'

import { fileURLToPath } from 'url';
import { dirname } from 'path';



const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const REGISTRY_PATH = path.resolve(ROOT, 'templates.json')
const DASHBOARD_ROOT = path.resolve(ROOT, 'dashboard')
const OUTPUT_ROOT = path.resolve(ROOT, 'out')
const INSTANCE_META_FILE = '.template-instance.json'
const BACKEND_CONFIG_FILE = path.resolve(ROOT, '.tmp', 'latest-backend-render-config.json')
const BACKEND_CONFIG_HISTORY_DIR = path.resolve(ROOT, '.tmp', 'backend-render-config-history')
const BACKEND_CONFIG_FORWARD_URL = process.env.BACKEND_CONFIG_FORWARD_URL || ''

let latestBackendConfig = null

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(JSON.stringify(payload, null, 2))
}

async function readJsonBody(req) {
  const chunks = []
  let totalBytes = 0
  const maxBytes = 1024 * 1024

  for await (const chunk of req) {
    totalBytes += chunk.length
    if (totalBytes > maxBytes) {
      throw new Error('Request body exceeds 1MB limit')
    }
    chunks.push(chunk)
  }

  if (chunks.length === 0) {
    return {}
  }

  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

async function persistLatestBackendConfig(payload) {
  latestBackendConfig = payload
  await fs.ensureDir(path.dirname(BACKEND_CONFIG_FILE))
  await fs.writeFile(BACKEND_CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8')

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const historyFilePath = path.join(BACKEND_CONFIG_HISTORY_DIR, `render-config-${ts}.json`)
  await fs.ensureDir(BACKEND_CONFIG_HISTORY_DIR)
  await fs.writeFile(historyFilePath, JSON.stringify(payload, null, 2), 'utf8')

  return {
    latestPath: BACKEND_CONFIG_FILE,
    historyPath: historyFilePath
  }
}

async function readLatestBackendConfig() {
  if (latestBackendConfig) return latestBackendConfig
  if (!(await fs.pathExists(BACKEND_CONFIG_FILE))) return null
  try {
    latestBackendConfig = JSON.parse(await fs.readFile(BACKEND_CONFIG_FILE, 'utf8'))
    return latestBackendConfig
  } catch {
    return null
  }
}

async function forwardBackendConfig(payload) {
  if (!BACKEND_CONFIG_FORWARD_URL) {
    return { forwarded: false, reason: 'No BACKEND_CONFIG_FORWARD_URL configured' }
  }

  const response = await fetch(BACKEND_CONFIG_FORWARD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  const body = await response.text()
  if (!response.ok) {
    throw new Error(`Forward endpoint failed (${response.status}): ${body || response.statusText}`)
  }

  return {
    forwarded: true,
    endpoint: BACKEND_CONFIG_FORWARD_URL,
    status: response.status,
    response: body
  }
}

async function readTemplateRegistry() {
  if (!(await fs.pathExists(REGISTRY_PATH))) {
    throw new Error(`templates.json not found at ${REGISTRY_PATH}`)
  }

  const raw = await fs.readFile(REGISTRY_PATH, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data)) {
    throw new Error('templates.json must be an array')
  }

  return data
}

function findTemplateById(templates, templateId) {
  return templates.find((t) => t && t.id === templateId)
}

async function runRenderer(args) {
  return runCommand(process.execPath, args, ROOT)
}

async function runCommand(command, args, cwd, options = {}) {
  const { shell = false } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })

    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })

    child.on('error', (err) => {
      reject(err)
    })

    child.on('close', (code) => {
      resolve({ code, stdout, stderr })
    })
  })
}

function outputUrlFromPath(targetPath) {
  if (!targetPath.startsWith(OUTPUT_ROOT)) {
    return null
  }
  const rel = path.relative(OUTPUT_ROOT, targetPath).replace(/\\/g, '/')
  return `/outputs/${rel}/`
}

async function prepareLaunchableOutput(outDir) {
  let launchUrl = outputUrlFromPath(outDir)
  let buildLogs = ''

  const packageJsonPath = path.join(outDir, 'package.json')
  if (!(await fs.pathExists(packageJsonPath))) {
    return { launchUrl, buildLogs }
  }

  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))
  if (!pkg.scripts || !pkg.scripts.build) {
    return { launchUrl, buildLogs }
  }

  const npmCmd = 'npm'
  const npmShell = process.platform === 'win32'
  const nodeModulesPath = path.join(outDir, 'node_modules')

  if (!(await fs.pathExists(nodeModulesPath))) {
    const install = await runCommand(npmCmd, ['install'], outDir, { shell: npmShell })
    buildLogs += install.stdout + install.stderr
    if (install.code !== 0) {
      throw new Error(`npm install failed for ${outDir}\n${install.stderr || install.stdout}`)
    }
  }

  const build = await runCommand(npmCmd, ['run', 'build'], outDir, { shell: npmShell })
  buildLogs += build.stdout + build.stderr
  if (build.code !== 0) {
    throw new Error(`npm run build failed for ${outDir}\n${build.stderr || build.stdout}`)
  }

  const distDir = path.join(outDir, 'dist')
  const distIndex = path.join(distDir, 'index.html')
  if (await fs.pathExists(distIndex)) {
    const distUrl = outputUrlFromPath(distDir)
    if (distUrl) {
      launchUrl = distUrl
    }
  }

  return { launchUrl, buildLogs }
}

async function getLaunchUrlForOutDir(outDir) {
  const distIndex = path.join(outDir, 'dist', 'index.html')
  if (await fs.pathExists(distIndex)) {
    return outputUrlFromPath(path.join(outDir, 'dist'))
  }
  return outputUrlFromPath(outDir)
}

async function writeInstanceMeta(outDir, templateId, values) {
  const metaPath = path.join(outDir, INSTANCE_META_FILE)
  const now = new Date().toISOString()

  let createdAt = now
  if (await fs.pathExists(metaPath)) {
    try {
      const existing = JSON.parse(await fs.readFile(metaPath, 'utf8'))
      if (existing && typeof existing.createdAt === 'string') {
        createdAt = existing.createdAt
      }
    } catch {
      // Ignore bad meta and rewrite it.
    }
  }

  const payload = {
    name: path.basename(outDir),
    templateId,
    values: values && typeof values === 'object' && !Array.isArray(values) ? values : null,
    createdAt,
    updatedAt: now
  }

  await fs.writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8')
  return payload
}

async function listInstances() {
  await fs.ensureDir(OUTPUT_ROOT)
  const entries = await fs.readdir(OUTPUT_ROOT)
  const instances = []

  for (const entry of entries) {
    const outDir = path.join(OUTPUT_ROOT, entry)
    const stat = await fs.stat(outDir).catch(() => null)
    if (!stat || !stat.isDirectory()) continue

    const metaPath = path.join(outDir, INSTANCE_META_FILE)
    let meta = null
    if (await fs.pathExists(metaPath)) {
      try {
        meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
      } catch {
        meta = null
      }
    }

    const openUrl = await getLaunchUrlForOutDir(outDir)
    instances.push({
      name: entry,
      outDir,
      openUrl,
      templateId: meta && typeof meta.templateId === 'string' ? meta.templateId : null,
      hasConfig: !!(meta && meta.values && typeof meta.values === 'object' && !Array.isArray(meta.values)),
      createdAt: meta && typeof meta.createdAt === 'string' ? meta.createdAt : stat.birthtime.toISOString(),
      updatedAt: meta && typeof meta.updatedAt === 'string' ? meta.updatedAt : stat.mtime.toISOString()
    })
  }

  instances.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return instances
}

async function getInstance(name) {
  const outDir = path.resolve(OUTPUT_ROOT, path.basename(name))
  if (!outDir.startsWith(OUTPUT_ROOT)) return null
  if (!(await fs.pathExists(outDir))) return null
  const stat = await fs.stat(outDir).catch(() => null)
  if (!stat || !stat.isDirectory()) return null

  const metaPath = path.join(outDir, INSTANCE_META_FILE)
  let meta = null
  if (await fs.pathExists(metaPath)) {
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    } catch {
      meta = null
    }
  }

  return {
    name: path.basename(outDir),
    outDir,
    openUrl: await getLaunchUrlForOutDir(outDir),
    templateId: meta && typeof meta.templateId === 'string' ? meta.templateId : null,
    values: meta && meta.values && typeof meta.values === 'object' && !Array.isArray(meta.values) ? meta.values : null,
    hasConfig: !!(meta && meta.values && typeof meta.values === 'object' && !Array.isArray(meta.values)),
    createdAt: meta && typeof meta.createdAt === 'string' ? meta.createdAt : stat.birthtime.toISOString(),
    updatedAt: meta && typeof meta.updatedAt === 'string' ? meta.updatedAt : stat.mtime.toISOString()
  }
}

function getMimeType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

async function serveFile(res, filePath) {
  if (!(await fs.pathExists(filePath))) {
    sendJson(res, 404, { error: 'File not found' })
    return true
  }

  const content = await fs.readFile(filePath)
  res.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(content)
  return true
}


  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  if (method === 'GET' && url.pathname === '/backend/render-config/latest') {
    try {
      const payload = await readLatestBackendConfig()
      if (!payload) {
        sendJson(res, 404, { error: 'No backend render payload captured yet' })
        return
      }
      sendJson(res, 200, { payload })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to read latest backend render payload',
        details: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (method === 'POST' && url.pathname === '/backend/render-config') {
    try {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'JSON object payload is required' })
        return
      }

      if (!body.template || typeof body.template !== 'object') {
        sendJson(res, 400, { error: 'template object is required' })
        return
      }

      if (!body.configuration || typeof body.configuration !== 'object' || Array.isArray(body.configuration)) {
        sendJson(res, 400, { error: 'configuration object is required' })
        return
      }

      const payload = {
        ...body,
        receivedAt: new Date().toISOString()
      }

      const stored = await persistLatestBackendConfig(payload)
      const forward = await forwardBackendConfig(payload)

      sendJson(res, 200, {
        success: true,
        message: 'Backend render payload received',
        stored,
        forward
      })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to process backend render payload',
        details: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
    await serveFile(res, path.join(DASHBOARD_ROOT, 'index.html'))
    return
  }

  if (method === 'GET' && url.pathname.startsWith('/dashboard/')) {
    const rel = url.pathname.slice('/dashboard/'.length)
    const normalized = path.normalize(rel)
    const filePath = path.resolve(DASHBOARD_ROOT, normalized)

    if (!filePath.startsWith(DASHBOARD_ROOT)) {
      sendJson(res, 400, { error: 'Invalid dashboard file path' })
      return
    }

    await serveFile(res, filePath)
    return
  }

  if (method === 'GET' && url.pathname.startsWith('/outputs/')) {
    const rel = decodeURIComponent(url.pathname.slice('/outputs/'.length))
    const normalized = path.normalize(rel)
    const requestedPath = path.resolve(OUTPUT_ROOT, normalized)

    if (!requestedPath.startsWith(OUTPUT_ROOT)) {
      sendJson(res, 400, { error: 'Invalid outputs path' })
      return
    }

    let targetFile = requestedPath
    if ((await fs.pathExists(requestedPath)) && (await fs.stat(requestedPath)).isDirectory()) {
      targetFile = path.join(requestedPath, 'index.html')
    }

    await serveFile(res, targetFile)
    return
  }

  if (method === 'GET' && url.pathname === '/templates') {
    try {
      const templates = await readTemplateRegistry()
      sendJson(res, 200, {
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          templatePath: t.templatePath,
          schemaPath: t.schemaPath,
          defaultValuesPath: t.defaultValuesPath
        }))
      })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to load templates registry',
        details: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (method === 'GET' && url.pathname === '/instances') {
    try {
      const instances = await listInstances()
      sendJson(res, 200, { instances })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to load instances',
        details: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  const instanceMatch = url.pathname.match(/^\/instances\/([^/]+)$/)
  if (method === 'GET' && instanceMatch) {
    try {
      const name = decodeURIComponent(instanceMatch[1])
      const instance = await getInstance(name)
      if (!instance) {
        sendJson(res, 404, { error: `Instance not found: ${name}` })
        return
      }
      sendJson(res, 200, { instance })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to load instance',
        details: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  const schemaMatch = url.pathname.match(/^\/templates\/([^/]+)\/schema$/)
  if (method === 'GET' && schemaMatch) {
    try {
      const templateId = decodeURIComponent(schemaMatch[1])
      const templates = await readTemplateRegistry()
      const tpl = findTemplateById(templates, templateId)

      if (!tpl) {
        sendJson(res, 404, { error: `Template id not found: ${templateId}` })
        return
      }

      const schemaPath = path.resolve(ROOT, tpl.schemaPath)
      if (!(await fs.pathExists(schemaPath))) {
        sendJson(res, 404, { error: `Schema file not found for template: ${templateId}` })
        return
      }

      const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
      sendJson(res, 200, {
        template: {
          id: tpl.id,
          name: tpl.name,
          description: tpl.description
        },
        schema
      })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Failed to load template schema',
        details: err instanceof Error ? err.message : String(err)
      })
    }
    return
  }

  if (method === 'POST' && url.pathname === '/render') {
    let tempValuesPath

    try {
      const body = await readJsonBody(req)
      const templateId = body.templateId
      const outInput = body.out

      if (!templateId || typeof templateId !== 'string') {
        sendJson(res, 400, { error: 'templateId is required and must be a string' })
        return
      }

      const templates = await readTemplateRegistry()
      const tpl = findTemplateById(templates, templateId)
      if (!tpl) {
        sendJson(res, 404, { error: `Template id not found: ${templateId}` })
        return
      }

      const requestedOutName = typeof outInput === 'string' && outInput.trim()
        ? path.basename(outInput.trim()) // strip any accidental path separators
        : null

      let outDir = path.resolve(ROOT, 'out', requestedOutName || `${templateId}-${Date.now()}`)
      let fallbackUsed = false

      const makeRendererArgs = (targetOutDir) => {
        const args = ['renderer.js', '--templateId', templateId, '--out', targetOutDir]
        if (body.valuesPath && typeof body.valuesPath === 'string') {
          args.push('--values', path.resolve(ROOT, body.valuesPath))
        } else if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
          args.push('--values', tempValuesPath)
        }
        return args
      }

      if (body.valuesPath && typeof body.valuesPath === 'string') {
        // Handled when building renderer args.
      } else if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
        tempValuesPath = path.resolve(ROOT, '.tmp', `render-values-${Date.now()}.json`)
        await fs.ensureDir(path.dirname(tempValuesPath))
        await fs.writeFile(tempValuesPath, JSON.stringify(body.values, null, 2), 'utf8')
      }

      let result = await runRenderer(makeRendererArgs(outDir))

      if (result.code !== 0 && requestedOutName) {
        // Windows can transiently lock files in an already existing output folder.
        // Retry once in a new suffixed folder so reconfigure + render does not fail hard.
        const fallbackOutName = `${requestedOutName}-${Date.now()}`
        const fallbackOutDir = path.resolve(ROOT, 'out', fallbackOutName)
        const retry = await runRenderer(makeRendererArgs(fallbackOutDir))
        if (retry.code === 0) {
          result = retry
          outDir = fallbackOutDir
          fallbackUsed = true
        } else {
          sendJson(res, 500, {
            error: 'Render failed',
            details: retry.stderr || retry.stdout || `Renderer exited with code ${retry.code}`,
            code: retry.code,
            stdout: retry.stdout,
            stderr: retry.stderr,
            initialAttempt: {
              code: result.code,
              stdout: result.stdout,
              stderr: result.stderr
            }
          })
          return
        }
      } else if (result.code !== 0) {
        sendJson(res, 500, {
          error: 'Render failed',
          details: result.stderr || result.stdout || `Renderer exited with code ${result.code}`,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr
        })
        return
      }

      await writeInstanceMeta(outDir, templateId, body.values)

      const shouldOpen = body.open !== false
      let launchUrl = null
      let buildLogs = ''

      if (shouldOpen) {
        const launchInfo = await prepareLaunchableOutput(outDir)
        launchUrl = launchInfo.launchUrl
        buildLogs = launchInfo.buildLogs
      }

      sendJson(res, 200, {
        success: true,
        templateId,
        requestedOut: requestedOutName,
        outDir,
        fallbackUsed,
        stdout: result.stdout.trim(),
        openUrl: launchUrl,
        buildLogs: buildLogs.trim()
      })
    } catch (err) {
      sendJson(res, 500, {
        error: 'Render request failed',
        details: err instanceof Error ? err.message : String(err)
      })
    } finally {
      if (tempValuesPath && (await fs.pathExists(tempValuesPath))) {
        await fs.remove(tempValuesPath)
      }
    }
    return
  }

  sendJson(res, 404, {
    error: 'Not Found',
    route: `${method} ${url.pathname}`,
    availableRoutes: ['GET /', 'GET /dashboard', 'GET /health', 'GET /templates', 'GET /templates/:id/schema', 'GET /instances', 'GET /instances/:name', 'GET /outputs/*', 'POST /render', 'POST /backend/render-config', 'GET /backend/render-config/latest']
  })
})


const PORT = Number(process.env.PORT) || 3001;
// IMPORTANT: bind to all interfaces (Azure requirement)
const HOST = '0.0.0.0';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Template API is running\n');
});

server.listen(PORT, HOST, () => {
  console.log(`Template API listening on http://${HOST}:${PORT}`);
})

})
