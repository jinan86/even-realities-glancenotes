// GlanceNotes backend — Node + Express.
//
// Serves the G2 app and the companion page. Talks to Notion through one
// of two adapters with the same interface:
//   mock  (default) — sample data in backend/notion-mock.js, no token
//   live  — @notionhq/client in backend/notion-live.js, needs
//           NOTION_TOKEN + NOTION_TASKS_DB_ID in the environment
//           (server-side only; never in the repo, never sent to clients).
//
// The Notion token and LLM keys are never exposed by any endpoint.
//
// Endpoints:
//   GET  /api/health        adapter + LLM chain status
//   GET  /api/tasks         today's tasks + one-line summary
//   GET  /api/notes         note titles (content stays server-side)
//   POST /api/ask           {question} -> grounded answer
//   POST /api/tasks         {title} -> add task
//   POST /api/tasks/:id/done
//   GET  /api/pending       pending add-task confirm + last answer (G2 polls)
//   POST /api/pending-add   {title} -> queue an add for G2 confirmation
//   POST /api/pending/ack   {kind: 'add'|'answer'} -> clear a pending item
import express from 'express';
import { mockAdapter } from './notion-mock.js';
import { createLiveAdapter } from './notion-live.js';
import { answerQuestion, summarizeTasks, llmStatus } from './llm.js';

const PORT = Number.parseInt(process.env.PORT || '3001', 10);
const ADAPTER = (process.env.NOTION_ADAPTER || 'mock').toLowerCase();

let adapter;
if (ADAPTER === 'live') {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_TASKS_DB_ID) {
    console.warn('[backend] NOTION_ADAPTER=live but NOTION_TOKEN/NOTION_TASKS_DB_ID missing — falling back to mock adapter');
    adapter = mockAdapter;
  } else {
    try {
      adapter = createLiveAdapter({
        token: process.env.NOTION_TOKEN,
        tasksDbId: process.env.NOTION_TASKS_DB_ID,
      });
    } catch (err) {
      console.warn(`[backend] live adapter failed to start (${err.message}) — falling back to mock adapter`);
      adapter = mockAdapter;
    }
  }
} else {
  adapter = mockAdapter;
}
console.log(`[backend] adapter: ${adapter.name}`);

// Pending items the glasses poll for: an add-task awaiting one-tap
// confirm, and the latest answer (e.g. from a question typed on the
// companion page) awaiting display.
const pending = { add: null, answer: null };

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  // The G2 webview (vite origin :5173) and the companion page call this
  // backend cross-origin in the simulator; allow it.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function summaryOf(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  const open = tasks.filter((t) => t.status !== 'done');
  const dueToday = open.filter((t) => !t.due || t.due <= today).length;
  const done = tasks.filter((t) => t.status === 'done').length;
  return `${dueToday} due today · ${done} done · ${open.length - dueToday} upcoming`;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, adapter: adapter.name, llm: llmStatus(), time: new Date().toISOString() });
});

app.get('/api/tasks', async (req, res) => {
  try {
    const tasks = await adapter.listTasks();
    const summary = await summarizeTasks(tasks);
    res.json({ tasks, summary, summaryLine: summaryOf(tasks) });
  } catch (err) {
    console.error('[backend] listTasks failed:', err.message);
    res.status(502).json({ error: `Notion ${adapter.name} adapter failed: ${err.message}` });
  }
});

app.get('/api/notes', async (req, res) => {
  try {
    const notes = await adapter.listNotes();
    res.json({ notes: notes.map((n) => ({ id: n.id, title: n.title })) });
  } catch (err) {
    console.error('[backend] listNotes failed:', err.message);
    res.status(502).json({ error: `Notion ${adapter.name} adapter failed: ${err.message}` });
  }
});

app.post('/api/ask', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });
  try {
    const [notes, tasks] = await Promise.all([adapter.listNotes(), adapter.listTasks()]);
    const result = await answerQuestion(question, notes, tasks);
    pending.answer = { question, answer: result.answer, source: result.source, layer: result.layer, at: Date.now() };
    console.log(`[backend] ask (${result.layer}${result.provider ? '/' + result.provider : ''}): ${question.slice(0, 60)}`);
    res.json(result);
  } catch (err) {
    console.error('[backend] ask failed:', err.message);
    res.status(502).json({ error: `ask failed: ${err.message}` });
  }
});

app.post('/api/tasks', async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const task = await adapter.addTask(title);
    if (pending.add && pending.add.title === title) pending.add = null;
    res.status(201).json({ task });
  } catch (err) {
    console.error('[backend] addTask failed:', err.message);
    res.status(502).json({ error: `add task failed: ${err.message}` });
  }
});

app.post('/api/tasks/:id/done', async (req, res) => {
  try {
    const task = await adapter.markDone(req.params.id);
    res.json({ task });
  } catch (err) {
    console.error('[backend] markDone failed:', err.message);
    res.status(502).json({ error: `mark done failed: ${err.message}` });
  }
});

app.post('/api/pending-add', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  pending.add = { title, at: Date.now() };
  res.json({ pending: pending.add });
});

app.get('/api/pending', (req, res) => {
  res.json({ pendingAdd: pending.add, lastAnswer: pending.answer });
});

app.post('/api/pending/ack', (req, res) => {
  if (req.body?.kind === 'add') pending.add = null;
  if (req.body?.kind === 'answer') pending.answer = null;
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[backend] GlanceNotes backend on http://localhost:${PORT} (adapter: ${adapter.name})`);
});
