// GlanceNotes — Notion tasks + notes on Even G2 glasses, with a grounded
// AI assistant.
//
// Pages (one text container each, exactly one isEventCapture — the
// container itself — per page, max 4 containers, we use 1):
//   home    — top 3 tasks today + one-line summary. Scroll picks a row,
//             tap marks the picked task done; the "Ask Notion →" row
//             opens the ask page. Double-tap shows the exit-confirm dialog.
//   ask     — preset questions. Scroll picks, tap asks, double-tap = back.
//   answer  — grounded answer from Notion. Any input = back home.
//   confirm — add-task from the companion page awaits one tap to confirm.
//
// The companion page (same webview, index.html) lets the phone type a
// question or a new task; the glasses poll the backend for pending items.
//
// Rules honoured here (see PLAN.md / PHASE0.md):
//   - Double-click on the ROOT page (home) MUST show the exit-confirm
//     dialog: shutDownPageContainer(1). Never a silent exit.
//   - Page changes use rebuildPageContainer; createStartUpPageContainer
//     runs once (a second create fails because container 1 already
//     exists — the Phase 0 HMR finding). On reload we fall back to rebuild.
//   - Display text is short: max ~7 lines, ~40 chars per line, one
//     action per tap. 576x288 monochrome.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const BACKEND = 'http://localhost:3001'
const POLL_MS = 2500

type Task = { id: string; title: string; status: string; due: string | null }
type Page = 'home' | 'ask' | 'answer' | 'confirm'

const PRESET_QUESTIONS = [
  'When is the Agentware kickoff?',
  'What is due today?',
  'When is the Even deadline?',
]

let bridge: EvenAppBridge
let page: Page = 'home'
let tasks: Task[] = []
let summaryLine = ''
let backendUp = false
let selectedIdx = 0
let presetIdx = 0
let answer: { question: string; answer: string; source: string | null } | null = null
let pendingAdd: string | null = null
let pageCreated = false
let asking = false

// ---------------------------------------------------------------- helpers
function log(...args: unknown[]) {
  console.log('[GlanceNotes]', ...args)
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function wrap(text: string, width = 40): string[] {
  const out: string[] = []
  for (const rawLine of String(text).split('\n')) {
    let line = rawLine
    while (line.length > width) {
      let cut = line.lastIndexOf(' ', width)
      if (cut <= 0) cut = width
      out.push(line.slice(0, cut))
      line = line.slice(cut).trimStart()
    }
    out.push(line)
  }
  return out
}

function trunc(text: string, n: number): string {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// Reads the event type out of one envelope. CLICK_EVENT is 0 and protobuf
// omits zero-value fields, so a tap arrives as an envelope whose
// eventType is undefined — resolve the default INSIDE the envelope check
// (see the template's comment: never default an envelope that is absent).
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// ---------------------------------------------------------------- rendering
type HomeItem = { kind: 'task'; task: Task } | { kind: 'ask' }

function homeItems(): HomeItem[] {
  const open = tasks.filter((t) => t.status !== 'done')
  const done = tasks.filter((t) => t.status === 'done')
  const shown = [...open, ...done].slice(0, 3)
  return [...shown.map((task): HomeItem => ({ kind: 'task', task })), { kind: 'ask' }]
}

function pageText(): string {
  if (page === 'home') {
    const items = homeItems()
    const lines = ['GlanceNotes — Today']
    if (!backendUp) {
      lines.push('Backend offline.')
      lines.push('Start: npm run backend')
    } else if (items.length === 1) {
      lines.push('No tasks. Add one from')
      lines.push('the companion page.')
      lines.push('▶ Ask Notion →')
    } else {
      items.forEach((item, i) => {
        const mark = i === selectedIdx ? '▶' : ' '
        if (item.kind === 'ask') lines.push(`${mark} Ask Notion →`)
        else lines.push(`${mark} ${item.task.status === 'done' ? 'x ' : ''}${trunc(item.task.title, 34)}`)
      })
    }
    lines.push(summaryLine || '—')
    lines.push('tap done · scroll pick · 2×tap exit')
    return lines.join('\n')
  }

  if (page === 'ask') {
    const lines = ['Ask Notion']
    PRESET_QUESTIONS.forEach((q, i) => {
      const mark = i === presetIdx ? '▶' : ' '
      lines.push(`${mark} ${trunc(q, 34)}`)
    })
    lines.push(`${presetIdx === PRESET_QUESTIONS.length ? '▶' : ' '} ← Back home`)
    lines.push('tap ask · scroll pick · 2×tap back')
    return lines.join('\n')
  }

  if (page === 'answer') {
    if (asking) return 'Ask Notion\nAsking your notes…\n(tap to cancel)'
    if (!answer) return 'Ask Notion\nNo answer yet.'
    const lines = [`Q: ${trunc(answer.question, 36)}`]
    lines.push(...wrap(answer.answer, 40).slice(0, 4))
    if (answer.source) lines.push(`— ${trunc(answer.source, 36)}`)
    lines.push('tap: back home')
    return lines.join('\n')
  }

  // confirm
  const lines = ['Add this task?']
  lines.push(...wrap(`"${pendingAdd ?? ''}"`, 40).slice(0, 3))
  lines.push('tap YES · scroll cancel')
  return lines.join('\n')
}

function mainContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'main',
    content,
    isEventCapture: 1,
  })
}

async function render() {
  const content = pageText()
  if (!pageCreated) {
    const result = await bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [mainContainer(content)],
      }),
    )
    log('Page created:', result === 0 ? 'success' : `failed (${result}) — falling back to rebuild`)
    pageCreated = true
    if (result !== 0) {
      await bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: 1, textObject: [mainContainer(content)] }),
      )
    }
  } else {
    await bridge.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: 1, textObject: [mainContainer(content)] }),
    )
  }
  renderCompanion()
}

function go(next: Page) {
  page = next
  void render()
}

// ---------------------------------------------------------------- backend
async function refreshTasks() {
  try {
    const data = await fetchJson(`${BACKEND}/api/tasks`)
    tasks = (data.tasks ?? []) as Task[]
    summaryLine = String(data.summaryLine || data.summary || '')
    backendUp = true
    if (selectedIdx >= homeItems().length) selectedIdx = Math.max(0, homeItems().length - 1)
  } catch (err) {
    backendUp = false
    log('tasks fetch failed:', String(err).slice(0, 120))
  }
}

async function pollPending() {
  try {
    const data = await fetchJson(`${BACKEND}/api/pending`)
    if (data.pendingAdd && page !== 'confirm') {
      pendingAdd = String(data.pendingAdd.title)
      go('confirm')
      return
    }
    if (data.lastAnswer && page !== 'answer') {
      answer = {
        question: String(data.lastAnswer.question),
        answer: String(data.lastAnswer.answer),
        source: data.lastAnswer.source ?? null,
      }
      go('answer')
      // Show once: ack so the poll does not push it again after going home.
      void fetchJson(`${BACKEND}/api/pending/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'answer' }),
      }).catch(() => undefined)
    }
  } catch {
    // Backend down — home page already shows that; stay quiet.
  }
}

async function askQuestion(question: string) {
  asking = true
  answer = null
  page = 'answer'
  await render()
  try {
    const data = await fetchJson(
      `${BACKEND}/api/ask`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      },
      60000,
    )
    answer = { question, answer: String(data.answer), source: data.source ?? null }
    log(`ask answered (${data.layer}${data.provider ? '/' + data.provider : ''})`)
  } catch (err) {
    answer = { question, answer: 'Could not reach the backend.', source: null }
    log('ask failed:', String(err).slice(0, 120))
  } finally {
    asking = false
    // The backend stored this answer as pending; ack so the poll does not
    // re-push it after we go home.
    void fetchJson(`${BACKEND}/api/pending/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'answer' }),
    }).catch(() => undefined)
    await render()
  }
}

async function markSelectedDone() {
  const item = homeItems()[selectedIdx]
  if (!item) return
  if (item.kind === 'ask') {
    presetIdx = 0
    go('ask')
    return
  }
  const task = item.task
  if (task.status === 'done') return
  try {
    await fetchJson(`${BACKEND}/api/tasks/${task.id}/done`, { method: 'POST' })
    log('marked done:', task.title)
    await refreshTasks()
    await render()
  } catch (err) {
    log('mark done failed:', String(err).slice(0, 120))
  }
}

async function confirmAdd() {
  if (!pendingAdd) return
  try {
    await fetchJson(`${BACKEND}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: pendingAdd }),
    })
    log('added task:', pendingAdd)
    pendingAdd = null
    await refreshTasks()
    go('home')
  } catch (err) {
    log('add task failed:', String(err).slice(0, 120))
  }
}

async function cancelAdd() {
  pendingAdd = null
  void fetchJson(`${BACKEND}/api/pending/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'add' }),
  }).catch(() => undefined)
  go('home')
}

// ---------------------------------------------------------------- input
function onTap() {
  if (page === 'home') void markSelectedDone()
  else if (page === 'ask') {
    if (presetIdx === PRESET_QUESTIONS.length) go('home')
    else void askQuestion(PRESET_QUESTIONS[presetIdx])
  } else if (page === 'answer') go('home')
  else if (page === 'confirm') void confirmAdd()
}

function onScrollDown() {
  if (page === 'home') {
    const n = homeItems().length
    if (n > 0) selectedIdx = (selectedIdx + 1) % n
    void render()
  } else if (page === 'ask') {
    presetIdx = (presetIdx + 1) % (PRESET_QUESTIONS.length + 1)
    void render()
  } else if (page === 'answer') {
    go('home')
  } else if (page === 'confirm') {
    void cancelAdd()
  }
}

function onScrollUp() {
  if (page === 'home') {
    const n = homeItems().length
    if (n > 0) selectedIdx = (selectedIdx - 1 + n) % n
    void render()
  } else if (page === 'ask') {
    presetIdx = (presetIdx - 1 + PRESET_QUESTIONS.length + 1) % (PRESET_QUESTIONS.length + 1)
    void render()
  } else if (page === 'answer') {
    go('home')
  } else if (page === 'confirm') {
    void cancelAdd()
  }
}

function onDoubleTap() {
  if (page === 'home') {
    // Root page: exit-confirm dialog (mode 1). Never a silent exit.
    log('double-tap on home — exit-confirm dialog (mode 1)')
    void bridge.shutDownPageContainer(1)
  } else {
    go('home')
  }
}

// ---------------------------------------------------------------- companion
function el(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function renderCompanion() {
  const status = el('comp-status')
  if (status) {
    status.textContent = backendUp
      ? `Backend OK · ${tasks.length} tasks · ${summaryLine}`
      : 'Backend offline — run: npm run backend'
  }
  const list = el('comp-tasks')
  if (list) {
    list.innerHTML = ''
    for (const t of tasks) {
      const li = document.createElement('li')
      li.textContent = `${t.status === 'done' ? '✓ ' : ''}${t.title}${t.due ? ` (${t.due})` : ''}`
      if (t.status !== 'done') {
        const btn = document.createElement('button')
        btn.textContent = 'Done'
        btn.onclick = async () => {
          await fetchJson(`${BACKEND}/api/tasks/${t.id}/done`, { method: 'POST' }).catch(() => undefined)
          await refreshTasks()
          renderCompanion()
        }
        li.appendChild(btn)
      }
      list.appendChild(li)
    }
  }
}

function wireCompanion() {
  const askBtn = el('ask-btn')
  const askInput = el('ask-input') as HTMLInputElement | null
  const askOut = el('comp-answer')
  if (askBtn && askInput) {
    const ask = async () => {
      const q = askInput.value.trim()
      if (!q) return
      if (askOut) askOut.textContent = 'Asking your notes…'
      try {
        const data = await fetchJson(
          `${BACKEND}/api/ask`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: q }),
          },
          60000,
        )
        if (askOut) {
          askOut.textContent = `${data.answer}${data.source ? ` — ${data.source}` : ''} (${data.layer}${data.provider ? '/' + data.provider : ''})`
        }
      } catch {
        if (askOut) askOut.textContent = 'Could not reach the backend.'
      }
      askInput.value = ''
    }
    askBtn.onclick = () => void ask()
    askInput.onkeydown = (e) => {
      if (e.key === 'Enter') void ask()
    }
  }

  const addBtn = el('add-btn')
  const addInput = el('add-input') as HTMLInputElement | null
  const addOut = el('comp-add-status')
  if (addBtn && addInput) {
    const add = async () => {
      const title = addInput.value.trim()
      if (!title) return
      try {
        await fetchJson(`${BACKEND}/api/pending-add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        })
        if (addOut) addOut.textContent = 'Sent to glasses — tap YES on G2 to confirm.'
      } catch {
        if (addOut) addOut.textContent = 'Could not reach the backend.'
      }
      addInput.value = ''
    }
    addBtn.onclick = () => void add()
    addInput.onkeydown = (e) => {
      if (e.key === 'Enter') void add()
    }
  }

  const refreshBtn = el('refresh-btn')
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      await refreshTasks()
      renderCompanion()
    }
  }
}

// ---------------------------------------------------------------- startup
bridge = await waitForEvenAppBridge()
log('bridge ready')
wireCompanion()
await refreshTasks()
await render()

setInterval(() => {
  void refreshTasks().then(() => {
    if (page === 'home') void render()
    else renderCompanion()
  })
  void pollPending()
}, POLL_MS)

const unsubscribe = bridge.onEvenHubEvent((event) => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  log('event sys=', sysType, 'text=', textType)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    onDoubleTap()
    return
  }
  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    onTap()
    return
  }
  if (sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    onScrollDown()
    return
  }
  if (sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT) {
    onScrollUp()
    return
  }
  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    unsubscribe()
  }
})
