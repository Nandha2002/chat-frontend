const templateListEl = document.getElementById('templateList')
const formTitleEl = document.getElementById('formTitle')
const formEl = document.getElementById('renderForm')
const formFieldsEl = document.getElementById('formFields')
const instanceListEl = document.getElementById('instanceList')
const outPathEl = document.getElementById('outPath')
const statusEl = document.getElementById('status')
const refreshBtn = document.getElementById('refreshTemplates')
const renderBtn = document.getElementById('renderBtn')

let templates = []
let instances = []
let selectedTemplate = null
let selectedSchema = null

// Updates the status panel with a primary message and optional detail text.
function setStatus(message, extra) {
  statusEl.textContent = extra ? `${message}\n\n${extra}` : message
}

// Recursively derives a sensible default value for a JSON schema node.
function buildDefaultFromSchema(schema) {
  if (!schema || typeof schema !== 'object') return null

  // Prefer explicit defaults from the schema when provided.
  if (schema.default !== undefined) return schema.default

  if (schema.type === 'object') {
    const obj = {}
    const props = schema.properties || {}
    // Build nested defaults for each object property.
    for (const key of Object.keys(props)) {
      const value = buildDefaultFromSchema(props[key])
      if (value !== null && value !== undefined) obj[key] = value
    }
    return obj
  }

  if (schema.type === 'array') {
    return Array.isArray(schema.default) ? schema.default : []
  }

  if (schema.type === 'boolean') return false
  if (schema.type === 'number' || schema.type === 'integer') return 0
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]
  if (schema.type === 'string') return ''

  return null
}

// Creates a form control for a schema property, including nested object sections.
function createField(name, schema, pathParts = []) {
  const fullPath = [...pathParts, name]
  const pathKey = fullPath.join('.')

  const wrap = document.createElement('div')
  wrap.className = 'field-row'

  const label = document.createElement('label')
  label.setAttribute('for', `f-${pathKey}`)
  label.textContent = schema.title || name

  // Render object properties as grouped nested fields.
  if (schema.type === 'object' && schema.properties) {
    const fieldset = document.createElement('div')
    fieldset.className = 'fieldset'

    const legend = document.createElement('div')
    legend.className = 'legend'
    legend.textContent = schema.title || name
    fieldset.appendChild(legend)

    for (const childName of Object.keys(schema.properties)) {
      fieldset.appendChild(createField(childName, schema.properties[childName], fullPath))
    }

    return fieldset
  }

  wrap.appendChild(label)

  // Arrays are edited as raw JSON for flexible value entry.
  if (schema.type === 'array' || (!schema.type && schema.items)) {
    const input = document.createElement('textarea')
    input.id = `f-${pathKey}`
    input.dataset.path = pathKey
    input.dataset.type = 'array'
    input.value = JSON.stringify(buildDefaultFromSchema(schema), null, 2)
    wrap.appendChild(input)
    return wrap
  }

  // Enums can be strict selects or editable inputs with suggested options.
  if (schema.enum && Array.isArray(schema.enum)) {
    const allowCustom = Boolean(schema['x-allowCustom'])
    const def = buildDefaultFromSchema(schema)

    if (allowCustom) {
      const input = document.createElement('input')
      const listId = `dl-${pathKey}`
      input.id = `f-${pathKey}`
      input.dataset.path = pathKey
      input.dataset.type = 'string'
      input.type = 'text'
      input.setAttribute('list', listId)
      if (def !== null && def !== undefined) input.value = String(def)

      const datalist = document.createElement('datalist')
      datalist.id = listId
      schema.enum.forEach((opt) => {
        const option = document.createElement('option')
        option.value = String(opt)
        datalist.appendChild(option)
      })

      wrap.appendChild(input)
      wrap.appendChild(datalist)
      return wrap
    }

    const select = document.createElement('select')
    select.id = `f-${pathKey}`
    select.dataset.path = pathKey
    select.dataset.type = 'string'
    schema.enum.forEach((opt) => {
      const option = document.createElement('option')
      option.value = String(opt)
      option.textContent = String(opt)
      select.appendChild(option)
    })
    if (def !== null && def !== undefined) select.value = String(def)
    wrap.appendChild(select)
    return wrap
  }

  // Booleans use an explicit true/false select.
  if (schema.type === 'boolean') {
    const select = document.createElement('select')
    select.id = `f-${pathKey}`
    select.dataset.path = pathKey
    select.dataset.type = 'boolean'
    ;['true', 'false'].forEach((opt) => {
      const option = document.createElement('option')
      option.value = opt
      option.textContent = opt
      select.appendChild(option)
    })
    const def = buildDefaultFromSchema(schema)
    select.value = def ? 'true' : 'false'
    wrap.appendChild(select)
    return wrap
  }

  // All remaining primitives are rendered as input fields.
  const input = document.createElement('input')
  input.id = `f-${pathKey}`
  input.dataset.path = pathKey
  input.dataset.type = schema.type || 'string'
  input.type = (schema.type === 'number' || schema.type === 'integer') ? 'number' : 'text'
  if (schema.type === 'number') input.step = 'any'
  if (schema.type === 'integer') input.step = '1'
  if (schema.minimum !== undefined) input.min = String(schema.minimum)
  if (schema.maximum !== undefined) input.max = String(schema.maximum)
  const def = buildDefaultFromSchema(schema)
  if (def !== null && def !== undefined) input.value = String(def)
  wrap.appendChild(input)
  return wrap
}

// Sets a nested value on an object using dot notation (for example "a.b.c").
function setDeepValue(target, pathKey, value) {
  const keys = pathKey.split('.')
  let cursor = target
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    // Ensure each intermediate node is a plain object before descending.
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

// Reads a nested value using dot notation; returns undefined when not found.
function getDeepValue(target, pathKey) {
  const keys = pathKey.split('.')
  let cursor = target
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !(key in cursor)) {
      return undefined
    }
    cursor = cursor[key]
  }
  return cursor
}

// Converts an absolute output directory into a public dashboard URL when possible.
function toOutputUrl(outDir) {
  if (!outDir || typeof outDir !== 'string') return null
  const normalized = outDir.replace(/\\/g, '/')
  const marker = '/out/'
  const idx = normalized.lastIndexOf(marker)
  if (idx === -1) return null
  const rel = normalized.slice(idx + marker.length)
  return `/outputs/${rel}/`
}

// Collects and type-converts all form input values into the render payload object.
function collectValues() {
  const values = {}
  const inputs = formFieldsEl.querySelectorAll('[data-path]')

  for (const input of inputs) {
    const pathKey = input.dataset.path
    const type = input.dataset.type || 'string'
    let value

    // Array values are entered as JSON in a textarea.
    if (type === 'array') {
      try {
        value = JSON.parse(input.value || '[]')
      } catch {
        throw new Error(`Invalid JSON array at ${pathKey}`)
      }
    } else if (type === 'boolean') {
      value = input.value === 'true'
    } else if (type === 'number') {
      value = Number(input.value)
    } else if (type === 'integer') {
      value = Number.parseInt(input.value, 10)
    } else {
      value = input.value
    }

    setDeepValue(values, pathKey, value)
  }

  return values
}

// Fetches a template schema used to dynamically build the config form.
async function fetchSchema(templateId) {
  const res = await fetch(`/templates/${encodeURIComponent(templateId)}/schema`)
  if (!res.ok) throw new Error(`Schema request failed (${res.status})`)
  return res.json()
}

// Fetches a previously rendered instance, including saved values.
async function fetchInstance(instanceName) {
  const res = await fetch(`/instances/${encodeURIComponent(instanceName)}`)
  if (!res.ok) throw new Error(`Instance request failed (${res.status})`)
  return res.json()
}

// Applies existing values back onto generated form fields (for reconfiguration flows).
function applyValuesToForm(values) {
  if (!values || typeof values !== 'object') return
  const inputs = formFieldsEl.querySelectorAll('[data-path]')
  for (const input of inputs) {
    const pathKey = input.dataset.path
    const type = input.dataset.type || 'string'
    const value = getDeepValue(values, pathKey)
    if (value === undefined || value === null) continue

    if (type === 'array') {
      input.value = JSON.stringify(value, null, 2)
    } else if (type === 'boolean') {
      input.value = value ? 'true' : 'false'
    } else {
      input.value = String(value)
    }
  }
}

// Loads template schema, renders fields, and optionally hydrates from preset values.
async function selectTemplate(template, presetValues) {
  setStatus('Loading schema...')
  selectedTemplate = template
  selectedSchema = null

  const data = await fetchSchema(template.id)
  selectedSchema = data.schema
  formTitleEl.textContent = `Configure: ${template.name}`
  renderBtn.disabled = false

  // Rebuild the form from schema root properties.
  formFieldsEl.innerHTML = ''
  const props = (selectedSchema && selectedSchema.properties) || {}
  for (const key of Object.keys(props)) {
    formFieldsEl.appendChild(createField(key, props[key]))
  }

  // Mark the selected template card as active in the UI.
  document.querySelectorAll('.template-card').forEach((card) => card.classList.remove('active'))
  const activeBtn = document.querySelector(`[data-template-id="${template.id}"]`)
  if (activeBtn) activeBtn.classList.add('active')

  if (presetValues) {
    applyValuesToForm(presetValues)
    setStatus('Previous configuration loaded. You can edit and render again.')
  } else {
    setStatus('Schema loaded. Fill values and click Render Template.')
  }
}

// Renders cards for previously generated instances and their actions.
function renderInstanceCards() {
  instanceListEl.innerHTML = ''

  if (!instances.length) {
    const empty = document.createElement('p')
    empty.className = 'instance-meta'
    empty.textContent = 'No previous outputs yet.'
    instanceListEl.appendChild(empty)
    return
  }

  for (const instance of instances) {
    const card = document.createElement('div')
    card.className = 'instance-card'

    const title = document.createElement('p')
    title.className = 'instance-title'
    title.textContent = instance.name

    const meta = document.createElement('p')
    meta.className = 'instance-meta'
    const tpl = instance.templateId || 'unknown-template'
    meta.textContent = `Template: ${tpl}`

    const actions = document.createElement('div')
    actions.className = 'instance-actions'

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.className = 'mini-btn primary'
    openBtn.textContent = 'Open'
    openBtn.addEventListener('click', () => {
      // Navigate to the generated output when an open URL is available.
      if (instance.openUrl) {
        window.location.assign(instance.openUrl)
      }
    })

    const cfgBtn = document.createElement('button')
    cfgBtn.type = 'button'
    cfgBtn.className = 'mini-btn'
    cfgBtn.textContent = 'Configure'
    // Enable reconfigure only when the instance has both template and config data.
    cfgBtn.disabled = !instance.templateId || !instance.hasConfig
    cfgBtn.addEventListener('click', async () => {
      try {
        const tpl = templates.find((t) => t.id === instance.templateId)
        if (!tpl) {
          throw new Error(`Template not found in registry: ${instance.templateId}`)
        }

        const detail = await fetchInstance(instance.name)
        outPathEl.value = detail.instance.name
        await selectTemplate(tpl, detail.instance.values)
      } catch (err) {
        setStatus('Failed to load previous configuration.', err.message || String(err))
      }
    })

    actions.appendChild(openBtn)
    actions.appendChild(cfgBtn)
    card.appendChild(title)
    card.appendChild(meta)
    card.appendChild(actions)
    instanceListEl.appendChild(card)
  }
}

// Renders selectable template cards from the registry list.
function renderTemplateCards() {
  templateListEl.innerHTML = ''
  for (const template of templates) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'template-card'
    btn.dataset.templateId = template.id
    btn.innerHTML = `<h3>${template.name}</h3><p>${template.description || ''}</p>`
    btn.addEventListener('click', async () => {
      try {
        await selectTemplate(template)
      } catch (err) {
        setStatus('Failed to load schema.', err.message || String(err))
      }
    })
    templateListEl.appendChild(btn)
  }
}

// Loads template registry from the server and refreshes template cards.
async function loadTemplates() {
  try {
    setStatus('Loading templates...')
    const res = await fetch('/templates')
    if (!res.ok) throw new Error(`Template list request failed (${res.status})`)
    const data = await res.json()
    templates = Array.isArray(data.templates) ? data.templates : []
    renderTemplateCards()
    setStatus(`Loaded ${templates.length} template(s). Select one to continue.`)
  } catch (err) {
    setStatus('Failed to load templates.', err.message || String(err))
  }
}

// Loads previously rendered instances and refreshes the instance list panel.
async function loadInstances() {
  try {
    const res = await fetch('/instances')
    if (!res.ok) throw new Error(`Instances request failed (${res.status})`)
    const data = await res.json()
    instances = Array.isArray(data.instances) ? data.instances : []
    renderInstanceCards()
  } catch (err) {
    instances = []
    renderInstanceCards()
    setStatus('Failed to load previous chatbots.', err.message || String(err))
  }
}

// Handles render form submission by collecting values and requesting server-side generation.
formEl.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!selectedTemplate || !selectedSchema) {
    setStatus('Select a template first.')
    return
  }

  try {
    const values = collectValues()
    const out = outPathEl.value.trim()

    // Send full template + configuration payload to backend endpoint.
    const backendPayload = {
      template: {
        id: selectedTemplate.id,
        name: selectedTemplate.name,
        description: selectedTemplate.description,
        templatePath: selectedTemplate.templatePath,
        schemaPath: selectedTemplate.schemaPath,
        defaultValuesPath: selectedTemplate.defaultValuesPath
      },
      configuration: values,
      renderOptions: {
        out: out || null,
        open: true
      },
      source: 'dashboard-render-submit',
      requestedAt: new Date().toISOString()
    }

    setStatus('Sending template configuration to backend...')

    const backendRes = await fetch('/backend/render-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(backendPayload)
    })

    const backendData = await backendRes.json()
    if (!backendRes.ok || !backendData.success) {
      throw new Error(backendData.details || backendData.error || `Backend config push failed (${backendRes.status})`)
    }

    const payload = {
      templateId: selectedTemplate.id,
      values,
      // Ask backend to open the result when render succeeds.
      open: true
    }

    if (out) payload.out = out   // passed to server; plain names go under ./out/<name>

    setStatus('Rendering template...')

    const res = await fetch('/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    const data = await res.json()
    if (!res.ok || !data.success) {
      throw new Error(data.details || data.error || `Render failed (${res.status})`)
    }

    if (data.fallbackUsed && data.outDir) {
      setStatus(
        'Render completed in a new output folder because the previous folder was locked.',
        JSON.stringify(data, null, 2)
      )
    } else {
      setStatus('Render completed successfully.', JSON.stringify(data, null, 2))
    }

    const targetUrl = data.openUrl || toOutputUrl(data.outDir)
    if (targetUrl) {
      // Small delay gives status UI time to update before navigation.
      setTimeout(() => {
        window.location.assign(targetUrl)
      }, 150)
      return
    }

    setStatus('Render completed, but no launch URL was returned.', JSON.stringify(data, null, 2))
  } catch (err) {
    setStatus('Render failed.', err.message || String(err))
  }
})

// Manually refresh both available templates and existing instances.
refreshBtn.addEventListener('click', () => {
  loadTemplates()
  loadInstances()
})

// Initial page bootstrap.
loadTemplates()
loadInstances()
