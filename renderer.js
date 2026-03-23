#!/usr/bin/env node
/**
 * Simple template renderer for Handlebars-based templates.
 * Usage:
 *   node renderer.js --template ./templates/Template_style1 --values ./templates/Template_style1/values.json --out ./out/hrva-chat
 *   node renderer.js --templateId Template_style1 --out ./out/hrva-chat
 *
 * Behavior:
 * - Loads template.yaml to locate schema.json, hooks, and files/
 * - Validates values against schema.json (if present)
 * - Runs optional hooks/pre_render.js(values) -> values
 * - Renders every *.hbs file (including allowing tokens in file names)
 * - Copies other files as-is
 */

import fs from 'fs-extra'
import path from 'path'
import Handlebars from 'handlebars'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import Ajv from 'ajv'

// -------------------------------
// CLI
// -------------------------------
const argv = yargs(hideBin(process.argv))
  .option('template', { type: 'string', describe: 'Path to template folder (the one containing template.yaml)' })
  .option('templateId', { type: 'string', describe: 'Template ID from templates.json' })
  .option('values',   { type: 'string', describe: 'Path to JSON file with values to inject (optional for --templateId)' })
  .option('out',      { type: 'string', demandOption: true, describe: 'Output directory for rendered project' })
  .strict()
  .help()
  .argv

const outDir = path.resolve(argv.out)
const workspaceRoot = process.cwd()

if (!argv.template && !argv.templateId) {
  console.error('Provide either --template or --templateId.')
  process.exit(1)
}

if (argv.template && argv.templateId) {
  console.error('Use only one of --template or --templateId.')
  process.exit(1)
}

let templateDir
let valuesPath

if (argv.templateId) {
  const registryPath = path.resolve(workspaceRoot, 'templates.json')
  if (!(await fs.pathExists(registryPath))) {
    console.error(`templates.json not found at: ${registryPath}`)
    process.exit(1)
  }

  const registryRaw = await fs.readFile(registryPath, 'utf8')
  const registry = JSON.parse(registryRaw)
  const tplEntry = Array.isArray(registry)
    ? registry.find((t) => t && t.id === argv.templateId)
    : null

  if (!tplEntry) {
    console.error(`Template id not found: ${argv.templateId}`)
    process.exit(1)
  }

  templateDir = path.resolve(workspaceRoot, tplEntry.templatePath || '')
  if (!tplEntry.defaultValuesPath && !argv.values) {
    console.error(`Template ${argv.templateId} has no defaultValuesPath and no --values was provided.`)
    process.exit(1)
  }
  valuesPath = path.resolve(workspaceRoot, argv.values || tplEntry.defaultValuesPath)
} else {
  templateDir = path.resolve(argv.template)
  if (!argv.values) {
    console.error('--values is required when using --template.')
    process.exit(1)
  }
  valuesPath = path.resolve(argv.values)
}

// -------------------------------
// Helpers (you can add more)
// -------------------------------
Handlebars.registerHelper('kebabCase', (str) => {
  if (typeof str !== 'string') return ''
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
})

// For conditional checks in templates: {{#ifEq a b}} ... {{/ifEq}}
Handlebars.registerHelper('ifEq', function(a, b, opts) {
  return a === b ? opts.fn(this) : opts.inverse(this)
})

// -------------------------------
// Load template meta & values
// -------------------------------
const tplYamlPath = path.join(templateDir, 'template.yaml')
if (!(await fs.pathExists(tplYamlPath))) {
  console.error(`template.yaml not found at: ${tplYamlPath}`)
  process.exit(1)
}

const yamlText = await fs.readFile(tplYamlPath, 'utf8')
// quick YAML parse without dependencies: assumes simple key: value pairs and short arrays
function naiveYamlParse(y) {
  // This is deliberately minimal—sufficient for the fields we wrote.
  const obj = {}
  let currentKey = null
  y.split(/\r?\n/).forEach(line => {
    if (!line.trim() || line.trim().startsWith('#')) return
    if (/^\s/.test(line) && currentKey && Array.isArray(obj[currentKey])) {
      const m = line.trim().match(/^-+\s*(.*)$/)
      if (m) obj[currentKey].push(m[1])
      return
    }
    const m = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (m) {
      const key = m[1]
      let val = m[2].trim()
      if (val === '') { obj[key] = ''; currentKey = key; return }
      if (val === 'true') val = true
      else if (val === 'false') val = false
      else if (/^\d+$/.test(val)) val = parseInt(val, 10)
      obj[key] = val
      // simple arrays like:
      // hooks:
      //   pre_render: hooks/pre_render.js
      currentKey = key
    }
  })
  return obj
}
const tplMeta = naiveYamlParse(yamlText)

const values = JSON.parse(await fs.readFile(valuesPath, 'utf8'))

// Removes enum constraints when schema marks a field as x-allowCustom.
// This keeps strict validation for all other fields, while allowing custom
// values for dashboard datalist-backed inputs.
function normalizeSchemaForCustomEnums(schemaNode) {
  if (!schemaNode || typeof schemaNode !== 'object') return schemaNode

  if (Array.isArray(schemaNode)) {
    return schemaNode.map((item) => normalizeSchemaForCustomEnums(item))
  }

  const clone = { ...schemaNode }
  if (clone['x-allowCustom'] === true && Array.isArray(clone.enum)) {
    delete clone.enum
  }

  for (const key of Object.keys(clone)) {
    const child = clone[key]
    if (child && typeof child === 'object') {
      clone[key] = normalizeSchemaForCustomEnums(child)
    }
  }

  return clone
}

// -------------------------------
// Validate against schema.json (if present)
// -------------------------------
const schemaPath = path.join(templateDir, tplMeta.schema || 'schema.json')
if (await fs.pathExists(schemaPath)) {
  const rawSchema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
  const schema = normalizeSchemaForCustomEnums(rawSchema)
  // Allow template-specific schema extension keywords (for example x-allowCustom).
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strictSchema: false })
  const validate = ajv.compile(schema)
  const ok = validate(values)
  if (!ok) {
    console.error('❌ Values failed schema validation:')
    console.error(validate.errors)
    process.exit(1)
  }
}

// -------------------------------
// Run pre_render hook (if present)
// -------------------------------
if (tplMeta.hooks) {
  // very simple parse for "pre_render: hooks/pre_render.js"
  const preLine = yamlText.match(/pre_render:\s*(.+)$/m)
  if (preLine && preLine[1]) {
    const prePath = path.join(templateDir, preLine[1].trim())
    if (await fs.pathExists(prePath)) {
      const mod = await import(pathToFileURL(prePath).href)
      if (typeof mod.default === 'function') {
        try {
          const newVals = await mod.default(structuredClone(values))
          Object.assign(values, newVals || {})
        } catch (err) {
          console.error('❌ pre_render hook failed:', err.message || err)
          process.exit(1)
        }
      }
    }
  }
}

// -------------------------------
// Render files
// -------------------------------
const filesRoot = path.join(templateDir, tplMeta.entrypoint || 'files')

async function renderDir(src, dest, ctx) {
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const e of entries) {
    const srcPath = path.join(src, e.name)

    // allow templating in file/dir names
    const nameTpl = Handlebars.compile(e.name)
    const outName = nameTpl(ctx).replace(/\.hbs$/, '')
    const destPath = path.join(dest, outName)

    if (e.isDirectory()) {
      await fs.ensureDir(destPath)
      await renderDir(srcPath, destPath, ctx)
    } else {
      const isHbs = e.name.endsWith('.hbs')
      if (isHbs) {
        const content = await fs.readFile(srcPath, 'utf8')
        const compiled = Handlebars.compile(content, { noEscape: true })
        const rendered = compiled(ctx)
        await fs.outputFile(destPath, rendered, 'utf8')
      } else {
        await fs.copy(srcPath, destPath)
      }
    }
  }
}

import { pathToFileURL } from 'url'

// Ensure output dir is clean
await fs.remove(outDir)
await fs.ensureDir(outDir)

// Execute render
await renderDir(filesRoot, outDir, values)

console.log('✅ Render complete:')
console.log('  Template :', templateDir)
console.log('  Output   :', outDir)
