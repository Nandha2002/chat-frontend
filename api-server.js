#!/usr/bin/env node
/**
 * Minimal HTTP server for Template API (Azure-safe)
 * - Single server declaration + single listen
 * - Uses process.env.PORT (required by Azure App Service)
 * - Serves /dashboard, /outputs, and JSON API routes
 * - Runs renderer.js via Node
 */

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { ensureContainer, uploadDirectory, downloadPrefixToDirectory, deletePrefix } from './blob-upload.js';

// -------- Paths & globals --------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Root of the running app. Keep this as process.cwd() so it works both locally and in Azure.
const ROOT = process.cwd();
const IS_AZURE_APP_SERVICE = !!(process.env.WEBSITE_SITE_NAME || process.env.WEBSITE_INSTANCE_ID);

// Load .env automatically for local runs so `npm start` works without manual export commands.
function loadDotEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1);

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

if (process.env.NODE_ENV !== 'production') {
  loadDotEnvFile(path.resolve(ROOT, '.env'));
}

const REGISTRY_PATH = path.resolve(ROOT, 'templates.json');
const DASHBOARD_ROOT = path.resolve(ROOT, 'dashboard');
const DATA_ROOT = path.resolve(
  process.env.APP_DATA_ROOT || (IS_AZURE_APP_SERVICE ? '/home/site/data' : ROOT)
);
const OUTPUT_ROOT = path.resolve(process.env.OUTPUT_ROOT || path.join(DATA_ROOT, 'out'));
const TMP_ROOT = path.resolve(process.env.TMP_ROOT || path.join(DATA_ROOT, '.tmp'));

const INSTANCE_META_FILE = '.template-instance.json';

const BACKEND_CONFIG_FILE = path.resolve(TMP_ROOT, 'latest-backend-render-config.json');
const BACKEND_CONFIG_HISTORY_DIR = path.resolve(TMP_ROOT, 'backend-render-config-history');
const BACKEND_CONFIG_FORWARD_URL = process.env.BACKEND_CONFIG_FORWARD_URL || '';
const HAS_BLOB_CONNECTION = !!process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_SYNC_ENABLED = String(
  process.env.ENABLE_BLOB_SYNC || (HAS_BLOB_CONNECTION ? 'true' : 'false')
).toLowerCase() !== 'false';
const CLEAN_INSTANCE_NODE_MODULES = String(
  process.env.CLEAN_INSTANCE_NODE_MODULES || (IS_AZURE_APP_SERVICE ? 'true' : 'false')
).toLowerCase() !== 'false';
const FORCE_REBUILD_ON_OUTPUT_REFRESH = String(
  process.env.FORCE_REBUILD_ON_OUTPUT_REFRESH || (IS_AZURE_APP_SERVICE ? 'true' : 'false')
).toLowerCase() !== 'false';
const WEBHOOK_SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || '';
const WEBHOOK_REBUILD_DEBOUNCE_MS = Number(process.env.WEBHOOK_REBUILD_DEBOUNCE_MS || 15000);
const BLOB_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'generated-sites';
const BLOB_SYNC_MIN_INTERVAL_MS = Number(process.env.BLOB_SYNC_MIN_INTERVAL_MS || 3000);

let latestBackendConfig = null;
const lastInstanceSyncAt = new Map();
const lastWebhookRebuildAt = new Map();

// -------- Helpers --------
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  const maxBytes = 1024 * 1024; // 1MB

  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error('Request body exceeds 1MB limit');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

async function persistLatestBackendConfig(payload) {
  latestBackendConfig = payload;
  await fs.ensureDir(path.dirname(BACKEND_CONFIG_FILE));
  await fs.writeFile(BACKEND_CONFIG_FILE, JSON.stringify(payload, null, 2), 'utf8');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const historyFilePath = path.join(BACKEND_CONFIG_HISTORY_DIR, `render-config-${ts}.json`);
  await fs.ensureDir(BACKEND_CONFIG_HISTORY_DIR);
  await fs.writeFile(historyFilePath, JSON.stringify(payload, null, 2), 'utf8');

  return { latestPath: BACKEND_CONFIG_FILE, historyPath: historyFilePath };
}

async function readLatestBackendConfig() {
  if (latestBackendConfig) return latestBackendConfig;
  if (!(await fs.pathExists(BACKEND_CONFIG_FILE))) return null;
  try {
    latestBackendConfig = JSON.parse(await fs.readFile(BACKEND_CONFIG_FILE, 'utf8'));
    return latestBackendConfig;
  } catch {
    return null;
  }
}

async function forwardBackendConfig(payload) {
  if (!BACKEND_CONFIG_FORWARD_URL) {
    return { forwarded: false, reason: 'No BACKEND_CONFIG_FORWARD_URL configured' };
  }

  const response = await fetch(BACKEND_CONFIG_FORWARD_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Forward endpoint failed (${response.status}): ${body || response.statusText}`);
  }

  return { forwarded: true, endpoint: BACKEND_CONFIG_FORWARD_URL, status: response.status, response: body };
}

async function readTemplateRegistry() {
  if (!(await fs.pathExists(REGISTRY_PATH))) {
    throw new Error(`templates.json not found at ${REGISTRY_PATH}`);
  }
  const raw = await fs.readFile(REGISTRY_PATH, 'utf8');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error('templates.json must be an array');
  }
  return data;
}

function findTemplateById(templates, templateId) {
  return templates.find((t) => t && t.id === templateId);
}

async function runCommand(command, args, cwd, options = {}) {
  const { shell = false } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runRenderer(args) {
  // Use Node to run renderer.js; cwd = ROOT lets us refer to 'renderer.js' relative to project root.
  return runCommand(process.execPath, args, ROOT);
}

function outputUrlFromPath(targetPath) {
  if (!targetPath.startsWith(OUTPUT_ROOT)) return null;
  const rel = path.relative(OUTPUT_ROOT, targetPath).replace(/\\/g, '/');
  return `/outputs/${rel}/`;
}

function shouldAutoSyncForOutputPath(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return false;
  if (parts.length === 1) return true; // /outputs/<instance>/

  // /outputs/<instance>/dist/ should sync before serving dist/index.html
  const second = String(parts[1] || '').toLowerCase();
  if (parts.length === 2 && second === 'dist') return true;

  const leaf = String(parts[parts.length - 1] || '').toLowerCase();
  return leaf === 'index.html';
}

async function prepareLaunchableOutput(outDir) {
  let launchUrl = outputUrlFromPath(outDir);
  let buildLogs = '';

  const indexPath = path.join(outDir, 'index.html');
  if (await fs.pathExists(indexPath)) {
    const html = await fs.readFile(indexPath, 'utf8');
    if (html.includes('./assets/index-') || html.includes('/assets/index-')) {
      // Recover source entrypoint if a previously published dist index replaced root index.html.
      const normalized = `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Template App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`;
      await fs.writeFile(indexPath, normalized, 'utf8');
    }
  }

  const packageJsonPath = path.join(outDir, 'package.json');
  if (!(await fs.pathExists(packageJsonPath))) {
    return { launchUrl, buildLogs };
  }

  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (!pkg.scripts || !pkg.scripts.build) {
    return { launchUrl, buildLogs };
  }

  const runNpm = async (npmArgs) => {
    if (process.platform === 'win32') {
      // Use cmd.exe directly to avoid spawn EINVAL with npm.cmd on some Windows setups.
      return runCommand('cmd.exe', ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`], outDir);
    }
    return runCommand('npm', npmArgs, outDir);
  };

  const nodeModulesPath = path.join(outDir, 'node_modules');

  if (CLEAN_INSTANCE_NODE_MODULES) {
    // Prevent cross-platform native binary reuse (for example esbuild) on Azure Linux workers.
    await fs.remove(nodeModulesPath).catch(() => null);
  }

  if (!(await fs.pathExists(nodeModulesPath))) {
    const install = await runNpm(['install', '--no-audit', '--no-fund']);
    buildLogs += install.stdout + install.stderr;
    if (install.code !== 0) {
      throw new Error(`npm install failed for ${outDir}\n${install.stderr || install.stdout}`);
    }
  }

  // Clear Vite transform cache to avoid stale bundle output after blob-synced source edits.
  await fs.remove(path.join(nodeModulesPath, '.vite')).catch(() => null);

  const build = await runNpm(['run', 'build']);
  buildLogs += build.stdout + build.stderr;
  if (build.code !== 0) {
    throw new Error(`npm run build failed for ${outDir}\n${build.stderr || build.stdout}`);
  }

  const distDir = path.join(outDir, 'dist');
  const distIndex = path.join(distDir, 'index.html');
  if (await fs.pathExists(distIndex)) {
    const distUrl = outputUrlFromPath(distDir);
    if (distUrl) launchUrl = distUrl;
  }

  return { launchUrl, buildLogs };
}

async function getLaunchUrlForOutDir(outDir) {
  const distIndex = path.join(outDir, 'dist', 'index.html');
  if (await fs.pathExists(distIndex)) {
    return outputUrlFromPath(path.join(outDir, 'dist'));
  }
  return outputUrlFromPath(outDir);
}

async function writeInstanceMeta(outDir, templateId, values) {
  const metaPath = path.join(outDir, INSTANCE_META_FILE);
  const now = new Date().toISOString();

  let createdAt = now;
  if (await fs.pathExists(metaPath)) {
    try {
      const existing = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (existing && typeof existing.createdAt === 'string') {
        createdAt = existing.createdAt;
      }
    } catch {
      // Ignore bad meta and rewrite it
    }
  }

  const payload = {
    name: path.basename(outDir),
    templateId,
    values: values && typeof values === 'object' && !Array.isArray(values) ? values : null,
    createdAt,
    updatedAt: now
  };

  await fs.writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function listInstances() {
  await fs.ensureDir(OUTPUT_ROOT);
  const entries = await fs.readdir(OUTPUT_ROOT);
  const instances = [];

  for (const entry of entries) {
    const outDir = path.join(OUTPUT_ROOT, entry);
    const stat = await fs.stat(outDir).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const metaPath = path.join(outDir, INSTANCE_META_FILE);
    let meta = null;
    if (await fs.pathExists(metaPath)) {
      try {
        meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      } catch {
        meta = null;
      }
    }

    const openUrl = await getLaunchUrlForOutDir(outDir);
    instances.push({
      name: entry,
      outDir,
      openUrl,
      templateId: meta && typeof meta.templateId === 'string' ? meta.templateId : null,
      hasConfig: !!(meta && meta.values && typeof meta.values === 'object' && !Array.isArray(meta.values)),
      createdAt: meta && typeof meta.createdAt === 'string' ? meta.createdAt : stat.birthtime.toISOString(),
      updatedAt: meta && typeof meta.updatedAt === 'string' ? meta.updatedAt : stat.mtime.toISOString()
    });
  }

  instances.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return instances;
}

async function getInstance(name) {
  const outDir = path.resolve(OUTPUT_ROOT, path.basename(name));
  if (!outDir.startsWith(OUTPUT_ROOT)) return null;
  if (!(await fs.pathExists(outDir))) return null;

  const stat = await fs.stat(outDir).catch(() => null);
  if (!stat || !stat.isDirectory()) return null;

  const metaPath = path.join(outDir, INSTANCE_META_FILE);
  let meta = null;
  if (await fs.pathExists(metaPath)) {
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      meta = null;
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
  };
}

function getStableBlobPrefix(templateId, instanceName) {
  return `${templateId}/${instanceName}/latest`;
}

function parseTemplateAndInstanceFromBlobUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }

  const segments = decodeURIComponent(u.pathname)
    .split('/')
    .filter(Boolean);

  if (segments.length < 5) return null;

  const [container, templateId, instanceName, latest, sourceKind] = segments;
  if (container !== BLOB_CONTAINER_NAME) return null;
  if (latest !== 'latest') return null;
  if (sourceKind !== 'src') return null;

  const fileName = segments[segments.length - 1] || '';
  const ext = path.extname(fileName).toLowerCase();
  const allowed = new Set(['.jsx', '.js', '.css', '.json', '.tsx', '.ts']);
  if (!allowed.has(ext)) return null;

  return { templateId, instanceName, fileName, ext };
}

async function syncInstanceFromBlobIfEnabled(instance) {
  if (!BLOB_SYNC_ENABLED || !instance || !instance.templateId) return { synced: false, reason: 'disabled-or-missing-template' };

  const container = await ensureContainer(BLOB_CONTAINER_NAME);
  const prefix = getStableBlobPrefix(instance.templateId, instance.name);
  const result = await downloadPrefixToDirectory(container, prefix, instance.outDir);
  if (!result.foundAny) {
    return { synced: false, reason: 'no-blob-content', prefix, container: BLOB_CONTAINER_NAME };
  }

  const refreshed = await getInstance(instance.name);
  return {
    synced: true,
    prefix,
    container: BLOB_CONTAINER_NAME,
    instance: refreshed || instance
  };
}

async function maybeSyncAndBuildInstance(instanceName, force = false) {
  const name = path.basename(instanceName || '');
  if (!name) return { synced: false, reason: 'invalid-instance-name' };

  const now = Date.now();
  const last = lastInstanceSyncAt.get(name) || 0;
  if (!force && now - last < BLOB_SYNC_MIN_INTERVAL_MS) {
    return { synced: false, reason: 'throttled' };
  }

  const instance = await getInstance(name);
  if (!instance) return { synced: false, reason: 'instance-not-found' };

  const sync = await syncInstanceFromBlobIfEnabled(instance);
  if (sync.synced) {
    // Keep existing dist as fallback if rebuild fails.
    await prepareLaunchableOutput(instance.outDir).catch((err) => {
      console.error(`maybeSyncAndBuildInstance build failed for ${name}:`, err?.message || err);
      return { launchUrl: null, buildLogs: '' };
    });
    lastInstanceSyncAt.set(name, now);
  }

  return sync;
}

async function publishInstanceToBlob(templateId, instanceName, outDir) {
  const distDir = path.join(outDir, 'dist');
  const hasDist = await fs.pathExists(path.join(distDir, 'index.html'));

  const container = await ensureContainer(BLOB_CONTAINER_NAME);
  const blobPrefix = getStableBlobPrefix(templateId, instanceName);
  await deletePrefix(container, blobPrefix);
  const blobBaseUrl = await uploadDirectory(container, outDir, blobPrefix);

  return {
    blobPrefix,
    blobBaseUrl,
    durableUrl: hasDist ? `${blobBaseUrl}dist/index.html` : `${blobBaseUrl}index.html`
  };
}

async function publishDistOnlyToBlob(templateId, instanceName, outDir) {
  const distDir = path.join(outDir, 'dist');
  const hasDist = await fs.pathExists(path.join(distDir, 'index.html'));
  if (!hasDist) {
    return { published: false, reason: 'dist-missing' };
  }

  const container = await ensureContainer(BLOB_CONTAINER_NAME);
  const blobPrefix = getStableBlobPrefix(templateId, instanceName);
  const distPrefix = `${blobPrefix}/dist`;
  await deletePrefix(container, distPrefix);
  const distBaseUrl = await uploadDirectory(container, distDir, distPrefix);

  return {
    published: true,
    blobPrefix,
    distBaseUrl,
    durableUrl: `${distBaseUrl}index.html`
  };
}

function getMimeType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function serveFile(res, filePath) {
  if (!(await fs.pathExists(filePath))) {
    sendJson(res, 404, { error: 'File not found' });
    return true;
  }

  const content = await fs.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(content);
  return true;
}

// -------- Server & routing (single declaration, single listen) --------
const PORT = Number(process.env.PORT) || 3001;

const server = http.createServer(async (req, res) => {
  try {
    const method = req.method || 'GET';
    // Construct absolute URL for safe parsing
    const url = new URL(req.url || '/', 'http://localhost');
    await fs.ensureDir(OUTPUT_ROOT);

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // ---- Health ----
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // ---- Backend config capture / forward ----
    if (method === 'GET' && url.pathname === '/backend/render-config/latest') {
      const payload = await readLatestBackendConfig();
      if (!payload) {
        sendJson(res, 404, { error: 'No backend render payload captured yet' });
        return;
      }
      sendJson(res, 200, { payload });
      return;
    }

    if (method === 'POST' && url.pathname === '/backend/render-config') {
      try {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'JSON object payload is required' });
          return;
        }
        if (!body.template || typeof body.template !== 'object') {
          sendJson(res, 400, { error: 'template object is required' });
          return;
        }
        if (!body.configuration || typeof body.configuration !== 'object' || Array.isArray(body.configuration)) {
          sendJson(res, 400, { error: 'configuration object is required' });
          return;
        }

        const payload = { ...body, receivedAt: new Date().toISOString() };
        const stored = await persistLatestBackendConfig(payload);
        const forward = await forwardBackendConfig(payload);

        sendJson(res, 200, { success: true, message: 'Backend render payload received', stored, forward });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to process backend render payload', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ---- Blob Event Grid webhook ----
    if (method === 'POST' && url.pathname === '/webhooks/blob-events') {
      try {
        if (WEBHOOK_SHARED_SECRET) {
          const headerSecret = String(req.headers['x-webhook-secret'] || '');
          const querySecret = String(url.searchParams.get('secret') || '');
          if (headerSecret !== WEBHOOK_SHARED_SECRET && querySecret !== WEBHOOK_SHARED_SECRET) {
            sendJson(res, 401, { error: 'Invalid webhook secret' });
            return;
          }
        }

        const body = await readJsonBody(req);
        const events = Array.isArray(body) ? body : [body];

        const validationEvent = events.find((e) => e && e.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent');
        if (validationEvent?.data?.validationCode) {
          sendJson(res, 200, { validationResponse: validationEvent.data.validationCode });
          return;
        }

        const eventCandidates = [];
        for (const evt of events) {
          if (!evt || typeof evt !== 'object') continue;
          const t = String(evt.eventType || '');
          if (t !== 'Microsoft.Storage.BlobCreated' && t !== 'Microsoft.Storage.BlobRenamed') continue;
          const parsed = parseTemplateAndInstanceFromBlobUrl(evt?.data?.url);
          if (!parsed) continue;
          eventCandidates.push({
            ...parsed,
            eventType: t,
            eventTime: evt.eventTime ? Date.parse(String(evt.eventTime)) : Date.now()
          });
        }

        const byInstance = new Map();
        for (const c of eventCandidates) {
          const key = `${c.templateId}/${c.instanceName}`;
          const prev = byInstance.get(key);
          if (!prev || c.eventTime > prev.eventTime) {
            byInstance.set(key, c);
          }
        }

        const processed = [];
        for (const candidate of byInstance.values()) {
          const key = `${candidate.templateId}/${candidate.instanceName}`;
          const now = Date.now();
          const last = lastWebhookRebuildAt.get(key) || 0;
          if (now - last < WEBHOOK_REBUILD_DEBOUNCE_MS) {
            processed.push({ ...candidate, skipped: true, reason: 'debounced' });
            continue;
          }

          const outDir = path.resolve(OUTPUT_ROOT, path.basename(candidate.instanceName));
          await fs.ensureDir(outDir);

          const container = await ensureContainer(BLOB_CONTAINER_NAME);
          const blobPrefix = getStableBlobPrefix(candidate.templateId, candidate.instanceName);
          const synced = await downloadPrefixToDirectory(container, blobPrefix, outDir);
          if (!synced.foundAny) {
            processed.push({ ...candidate, skipped: true, reason: 'no-blob-content', blobPrefix });
            continue;
          }

          await writeInstanceMeta(outDir, candidate.templateId, null);
          const launchInfo = await prepareLaunchableOutput(outDir);
          const published = await publishDistOnlyToBlob(candidate.templateId, candidate.instanceName, outDir);
          lastWebhookRebuildAt.set(key, now);

          processed.push({
            ...candidate,
            synced: true,
            rebuilt: true,
            openUrl: launchInfo.launchUrl,
            durableUrl: published.durableUrl || null
          });
        }

        sendJson(res, 200, {
          success: true,
          received: events.length,
          matched: eventCandidates.length,
          processedCount: processed.length,
          processed
        });
      } catch (err) {
        sendJson(res, 500, {
          error: 'Failed to process blob webhook',
          details: err instanceof Error ? err.message : String(err)
        });
      }
      return;
    }

    // ---- Dashboard ----
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
      await serveFile(res, path.join(DASHBOARD_ROOT, 'index.html'));
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/dashboard/')) {
      const rel = url.pathname.slice('/dashboard/'.length);
      const normalized = path.normalize(rel);
      const filePath = path.resolve(DASHBOARD_ROOT, normalized);
      if (!filePath.startsWith(DASHBOARD_ROOT)) {
        sendJson(res, 400, { error: 'Invalid dashboard file path' });
        return;
      }
      await serveFile(res, filePath);
      return;
    }

    // ---- Outputs ----
    if (method === 'GET' && url.pathname.startsWith('/outputs/')) {
      const rel = decodeURIComponent(url.pathname.slice('/outputs/'.length));
      const normalized = path.normalize(rel);
      const parts = normalized.split(/[\\/]/).filter(Boolean);
      const instanceName = parts[0] || '';
      const requestedPath = path.resolve(OUTPUT_ROOT, normalized);

      if (BLOB_SYNC_ENABLED) {
        if (instanceName && shouldAutoSyncForOutputPath(parts)) {
          await maybeSyncAndBuildInstance(instanceName, FORCE_REBUILD_ON_OUTPUT_REFRESH).catch(() => null);
        }
      }

      if (!requestedPath.startsWith(OUTPUT_ROOT)) {
        sendJson(res, 400, { error: 'Invalid outputs path' });
        return;
      }

      let targetFile = requestedPath;
      if ((await fs.pathExists(requestedPath)) && (await fs.stat(requestedPath)).isDirectory()) {
        targetFile = path.join(requestedPath, 'index.html');
      }

      // If /outputs/<instance>/dist/... is requested but dist is missing,
      // fallback to root output path (where published runnable assets live).
      if (!(await fs.pathExists(targetFile)) && parts.length >= 2 && parts[1] === 'dist' && instanceName) {
        const fallbackParts = [instanceName, ...parts.slice(2)];
        let fallbackPath = path.resolve(OUTPUT_ROOT, fallbackParts.join('/'));
        if ((await fs.pathExists(fallbackPath)) && (await fs.stat(fallbackPath)).isDirectory()) {
          fallbackPath = path.join(fallbackPath, 'index.html');
        }
        if (await fs.pathExists(fallbackPath)) {
          targetFile = fallbackPath;
        }
      }

      await serveFile(res, targetFile);
      return;
    }

    // ---- Templates registry ----
    if (method === 'GET' && url.pathname === '/templates') {
      try {
        const templates = await readTemplateRegistry();
        sendJson(res, 200, {
          templates: templates.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            templatePath: t.templatePath,
            schemaPath: t.schemaPath,
            defaultValuesPath: t.defaultValuesPath
          }))
        });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to load templates registry', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ---- Instances ----
    if (method === 'GET' && url.pathname === '/instances') {
      try {
        const instances = await listInstances();
        sendJson(res, 200, { instances });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to load instances', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const instanceMatch = url.pathname.match(/^\/instances\/([^/]+)$/);
    if (method === 'GET' && instanceMatch) {
      try {
        const name = decodeURIComponent(instanceMatch[1]);
        let instance = await getInstance(name);
        if (!instance) {
          sendJson(res, 404, { error: `Instance not found: ${name}` });
          return;
        }
        const sync = await maybeSyncAndBuildInstance(name, true);
        if (sync.synced && sync.instance) {
          instance = sync.instance;
        } else {
          instance = await getInstance(name);
        }
        sendJson(res, 200, { instance });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to load instance', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const instanceSyncMatch = url.pathname.match(/^\/instances\/([^/]+)\/sync$/);
    if (method === 'POST' && instanceSyncMatch) {
      try {
        const name = decodeURIComponent(instanceSyncMatch[1]);
        let instance = await getInstance(name);
        if (!instance) {
          sendJson(res, 404, { error: `Instance not found: ${name}` });
          return;
        }
        if (!BLOB_SYNC_ENABLED) {
          sendJson(res, 400, { error: 'Blob sync is disabled', enabled: false });
          return;
        }
        const sync = await maybeSyncAndBuildInstance(name, true);
        if (sync.synced) {
          const refreshed = await getInstance(name);
          sendJson(res, 200, {
            success: true,
            message: 'Instance synced from blob',
            ...sync,
            instance: refreshed || instance
          });
        } else {
          sendJson(res, 404, {
            success: false,
            message: 'No blob content found for this instance',
            ...sync
          });
        }
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to sync instance from blob', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const instanceRebuildMatch = url.pathname.match(/^\/instances\/([^/]+)\/rebuild-and-publish$/);
    if (method === 'POST' && instanceRebuildMatch) {
      try {
        const name = decodeURIComponent(instanceRebuildMatch[1]);
        let instance = await getInstance(name);
        if (!instance) {
          sendJson(res, 404, { error: `Instance not found: ${name}` });
          return;
        }
        if (!instance.templateId) {
          sendJson(res, 400, { error: 'Instance is missing templateId in metadata' });
          return;
        }

        // Pull latest source edits from blob first (if available), then rebuild and republish.
        const sync = await syncInstanceFromBlobIfEnabled(instance);
        if (sync.synced && sync.instance) {
          instance = sync.instance;
        } else {
          instance = await getInstance(name);
        }
        if (!instance) {
          sendJson(res, 404, { error: `Instance not found after sync: ${name}` });
          return;
        }

        const distDir = path.join(instance.outDir, 'dist');
        await fs.remove(distDir).catch(() => null);
        const launchInfo = await prepareLaunchableOutput(instance.outDir);

        const published = await publishInstanceToBlob(instance.templateId, instance.name, instance.outDir);
        sendJson(res, 200, {
          success: true,
          message: 'Instance rebuilt from source and republished to blob',
          instance: await getInstance(name),
          openUrl: launchInfo.launchUrl,
          buildLogs: launchInfo.buildLogs.trim(),
          blobSyncEnabled: BLOB_SYNC_ENABLED,
          blobContainer: BLOB_CONTAINER_NAME,
          ...published
        });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to rebuild and publish instance', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ---- Template schema ----
    const schemaMatch = url.pathname.match(/^\/templates\/([^/]+)\/schema$/);
    if (method === 'GET' && schemaMatch) {
      try {
        const templateId = decodeURIComponent(schemaMatch[1]);
        const templates = await readTemplateRegistry();
        const tpl = findTemplateById(templates, templateId);

        if (!tpl) {
          sendJson(res, 404, { error: `Template id not found: ${templateId}` });
          return;
        }

        const schemaPath = path.resolve(ROOT, tpl.schemaPath);
        if (!(await fs.pathExists(schemaPath))) {
          sendJson(res, 404, { error: `Schema file not found for template: ${templateId}` });
          return;
        }

        const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
        sendJson(res, 200, {
          template: { id: tpl.id, name: tpl.name, description: tpl.description },
          schema
        });
      } catch (err) {
        sendJson(res, 500, { error: 'Failed to load template schema', details: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ---- Render ----
    if (method === 'POST' && url.pathname === '/render') {
      let tempValuesPath;
      try {
        const body = await readJsonBody(req);
        const templateId = body.templateId;
        const outInput = body.out;

        if (!templateId || typeof templateId !== 'string') {
          sendJson(res, 400, { error: 'templateId is required and must be a string' });
          return;
        }

        const templates = await readTemplateRegistry();
        const tpl = findTemplateById(templates, templateId);
        if (!tpl) {
          sendJson(res, 404, { error: `Template id not found: ${templateId}` });
          return;
        }

        const requestedOutName =
          typeof outInput === 'string' && outInput.trim()
            ? path.basename(outInput.trim())
            : null;

        let outDir = path.resolve(ROOT, 'out', requestedOutName || `${templateId}-${Date.now()}`);
        let fallbackUsed = false;

        const makeRendererArgs = (targetOutDir) => {
          const args = ['renderer.js', '--templateId', templateId, '--out', targetOutDir];
          if (body.valuesPath && typeof body.valuesPath === 'string') {
            args.push('--values', path.resolve(ROOT, body.valuesPath));
          } else if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
            args.push('--values', tempValuesPath);
          }
          return args;
        };

        if (body.valuesPath && typeof body.valuesPath === 'string') {
          // handled in makeRendererArgs
        } else if (body.values && typeof body.values === 'object' && !Array.isArray(body.values)) {
          tempValuesPath = path.resolve(ROOT, '.tmp', `render-values-${Date.now()}.json`);
          await fs.ensureDir(path.dirname(tempValuesPath));
          await fs.writeFile(tempValuesPath, JSON.stringify(body.values, null, 2), 'utf8');
        }

        let result = await runRenderer(makeRendererArgs(outDir));

        if (result.code !== 0 && requestedOutName) {
          // Retry once in a suffixed folder (helps on Windows file locks)
          const fallbackOutName = `${requestedOutName}-${Date.now()}`;
          const fallbackOutDir = path.resolve(ROOT, 'out', fallbackOutName);
          const retry = await runRenderer(makeRendererArgs(fallbackOutDir));
          if (retry.code === 0) {
            result = retry;
            outDir = fallbackOutDir;
            fallbackUsed = true;
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
            });
            return;
          }
        } else if (result.code !== 0) {
          sendJson(res, 500, {
            error: 'Render failed',
            details: result.stderr || result.stdout || `Renderer exited with code ${result.code}`,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr
          });
          return;
        }

        await writeInstanceMeta(outDir, templateId, body.values);

        const shouldOpen = body.open !== false;
        let launchUrl = null;
        let buildLogs = '';

        if (shouldOpen) {
          const launchInfo = await prepareLaunchableOutput(outDir);
          launchUrl = launchInfo.launchUrl;
          buildLogs = launchInfo.buildLogs;
        }

        // Publish to Blob Storage (best effort).
        // 1) Upload full source tree so users can edit all project files in blob.
        // 2) If dist exists, overlay it so index.html is runnable from blob URL.
        let blobBaseUrl = null;
        let durableUrl = null;
        let blobPrefix = null;
        try {
          const folderName = path.basename(outDir);
          const published = await publishInstanceToBlob(templateId, folderName, outDir);
          blobPrefix = published.blobPrefix;
          blobBaseUrl = published.blobBaseUrl;
          durableUrl = published.durableUrl;
        } catch (e) {
          console.error('Blob upload failed:', e?.message || e);
        }

        sendJson(res, 200, {
          success: true,
          templateId,
          requestedOut: requestedOutName,
          outDir,
          fallbackUsed,
          stdout: result.stdout.trim(),
          openUrl: launchUrl,
          blobSyncEnabled: BLOB_SYNC_ENABLED,
          blobContainer: BLOB_CONTAINER_NAME,
          blobPrefix,
          blobBaseUrl,
          durableUrl,
          buildLogs: buildLogs.trim()
        });
      } catch (err) {
        sendJson(res, 500, { error: 'Render request failed', details: err instanceof Error ? err.message : String(err) });
      } finally {
        if (tempValuesPath && (await fs.pathExists(tempValuesPath))) {
          await fs.remove(tempValuesPath);
        }
      }
      return;
    }

    // ---- 404 fallback ----
    sendJson(res, 404, {
      error: 'Not Found',
      route: `${method} ${url.pathname}`,
      availableRoutes: [
        'GET /',
        'GET /dashboard',
        'GET /health',
        'GET /templates',
        'GET /templates/:id/schema',
        'GET /instances',
        'GET /instances/:name',
        'POST /instances/:name/sync',
        'POST /instances/:name/rebuild-and-publish',
        'POST /webhooks/blob-events',
        'GET /outputs/*',
        'POST /render',
        'POST /backend/render-config',
        'GET /backend/render-config/latest'
      ]
    });
  } catch (err) {
    sendJson(res, 500, { error: 'Unhandled server error', details: err instanceof Error ? err.message : String(err) });
  }
});

// Bind on all interfaces by omitting HOST; Azure injects PORT.
// Using only PORT defaults to 0.0.0.0 on Linux (App Service).
server.listen(PORT, () => {
  console.log(`Template API listening on port ${PORT}`);
  console.log(`Data root: ${DATA_ROOT}`);
  console.log(`Output root: ${OUTPUT_ROOT}`);
  console.log(`Blob sync enabled: ${BLOB_SYNC_ENABLED}`);
});
