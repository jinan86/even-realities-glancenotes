// Mock Notion adapter — GlanceNotes dev adapter.
//
// Sample data mirrors the real workspace zee shared with the GlanceNotes
// integration on 23 Nov 2026: a "Tasks" database plus 3 sample note pages.
// Mutations (add / mark done) persist to backend/data.json (gitignored)
// so a backend restart keeps demo state. The live adapter
// (notion-live.js) implements the same interface against @notionhq/client.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data.json');

const DEFAULT_TASKS = [
  { id: 'mock-task-1', title: 'Ship GlanceNotes home screen', status: 'open', due: '2026-11-23', source: 'Tasks' },
  { id: 'mock-task-2', title: 'Record GlanceNotes demo video', status: 'open', due: '2026-11-23', source: 'Tasks' },
  { id: 'mock-task-3', title: 'Submit Even Realities build', status: 'open', due: '2026-11-27', source: 'Tasks' },
  { id: 'mock-task-4', title: 'Register on DoraHacks', status: 'done', due: '2026-11-23', source: 'Tasks' },
];

// Note text is deliberately short, factual, and demo-safe: it is what the
// AI assistant grounds its answers in.
const DEFAULT_NOTES = [
  {
    id: 'mock-note-1',
    title: 'Agentware brief',
    text: 'Agentware 2026 is a 72-hour autonomous-agent hackathon. Kickoff is Saturday 28 November 2026 at 01:00 WIB and the freeze is Tuesday 1 December 2026 at 01:00 WIB. Zee builds in track T5 Developer Workflow, an agent called Gatekeeper. First prize is $800. Solo entry is allowed.',
  },
  {
    id: 'mock-note-2',
    title: 'Even Realities plan',
    text: 'GlanceNotes is zee\u2019s entry for the Even Realities hackathon, track 04 AI Assistants and Work. Submissions close on 30 November 2026 at 02:59 WIB. The target is to submit by 27 November 2026. Demo Day is 3 December 2026 in Dubai and finalists may demo remotely. The prize pool is $10,000 USDT.',
  },
  {
    id: 'mock-note-3',
    title: 'Delphi notes',
    text: 'Delphi Agent Arena: Evidence Mining closes 12 December 2026. API access opens 25 November 2026 and submissions open 26 November 2026. Zee\u2019s agent is called Evidence Miner. First prize is $3,000 USDC. The wallet linking issue is parked until API access opens.',
  },
];

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw.tasks) && Array.isArray(raw.notes)) return raw;
  } catch {
    // No saved state yet — fall through to defaults.
  }
  return { tasks: structuredClone(DEFAULT_TASKS), notes: structuredClone(DEFAULT_NOTES) };
}

function save(state) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(`[mock] could not persist ${DATA_FILE}: ${err.message}`);
  }
}

const state = load();
let counter = 100;

export const mockAdapter = {
  name: 'mock',

  async listTasks() {
    return structuredClone(state.tasks);
  },

  async listNotes() {
    return structuredClone(state.notes);
  },

  async addTask(title) {
    const task = {
      id: `mock-task-${Date.now()}-${counter++}`,
      title: String(title).trim().slice(0, 120),
      status: 'open',
      due: new Date().toISOString().slice(0, 10),
      source: 'Tasks',
    };
    if (!task.title) throw new Error('empty title');
    state.tasks.push(task);
    save(state);
    return structuredClone(task);
  },

  async markDone(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`unknown task ${id}`);
    task.status = 'done';
    save(state);
    return structuredClone(task);
  },
};
