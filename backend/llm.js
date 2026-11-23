// LLM chain for GlanceNotes answers — zee's proven free chain, same
// order as the Sentinel AI service (reactive-buildathon):
//   1. 100milionseek (deepseek-v4.1-flash-free)
//   2. OpenRouter (baidu/ernie-5.5-flash-preview:free, max_tokens 4096 —
//      Ernie reasons ~1000 tokens before answering; smaller budgets
//      truncate the reply)
//   3. Coarena (deepseek-v4-1-flash-1017)
//   4. Heuristic (keyword matching over the fetched Notion content)
//
// Auth: a literal env key wins; otherwise the Secure Vault surrogate
// (see surrogate.js) is used. No key is ever hardcoded or logged.
// NEVER send secrets through these proxies — only the user's question
// and their own Notion note text, which is demo content.
//
// If no provider answers, the heuristic still produces a grounded
// answer, so the demo works end-to-end with zero keys.
import { getSurrogate } from './surrogate.js';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function intEnv(name, fallback) {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

const PROVIDERS = [
  {
    name: '100milionseek',
    connection: 'custom.100milionseek',
    url: process.env.LLM_API_URL || 'https://100milionseek.top/v1/chat/completions',
    model: process.env.LLM_MODEL || 'deepseek-v4.1-flash-free',
    maxTokens: intEnv('LLM_MAX_TOKENS', 512),
    key: process.env.LLM_API_KEY || '',
    hosts: ['100milionseek.top'],
    attempts: 2,
  },
  {
    name: 'openrouter',
    connection: 'custom.openrouter',
    url: process.env.LLM2_API_URL || 'https://openrouter.ai/api/v1/chat/completions',
    model: process.env.LLM2_MODEL || 'baidu/ernie-5.5-flash-preview:free',
    maxTokens: intEnv('LLM2_MAX_TOKENS', 4096),
    key: process.env.LLM2_API_KEY || '',
    hosts: ['openrouter.ai'],
    attempts: 1,
    enabled: process.env.LLM2_ENABLED !== '0',
  },
  {
    name: 'coarena',
    connection: 'custom.coarena',
    url: process.env.LLM3_API_URL || 'https://coarena.ai/api/v1/chat/completions',
    model: process.env.LLM3_MODEL || 'deepseek-v4-1-flash-1017',
    maxTokens: intEnv('LLM3_MAX_TOKENS', 512),
    key: process.env.LLM3_API_KEY || '',
    hosts: ['coarena.ai'],
    attempts: 1,
    enabled: process.env.LLM3_ENABLED !== '0',
  },
].filter((p) => p.enabled !== false);

// Surrogate cache: an hsurr: value is a reference, not a secret, so
// caching it in memory is safe. On a 401 we re-fetch once.
const surrogateCache = new Map();

async function authHeader(provider) {
  if (provider.key) return `Bearer ${provider.key}`;
  let entry = surrogateCache.get(provider.name);
  if (!entry) {
    entry = await getSurrogate(provider.connection);
    surrogateCache.set(provider.name, entry);
  }
  return `Bearer ${entry.surrogate}`;
}

async function callProvider(provider, messages, timeoutMs = 20000) {
  let lastErr = null;
  for (let attempt = 1; attempt <= provider.attempts; attempt++) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': UA,
        Authorization: await authHeader(provider),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(provider.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: provider.model,
            messages,
            temperature: 0,
            max_tokens: provider.maxTokens,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401) {
        // Surrogate may have expired — fetch a fresh one once and retry.
        surrogateCache.delete(provider.name);
        if (attempt === 1) {
          headers.Authorization = await authHeader(provider);
          continue;
        }
        throw new Error('HTTP 401');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const out = await res.json();
      const text = String(out?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('empty reply');
      return { text, servedBy: out?.model || provider.model };
    } catch (err) {
      lastErr = err;
      console.warn(`[llm] ${provider.name} attempt ${attempt}/${provider.attempts} failed: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  throw lastErr || new Error('provider failed');
}

// ---------------------------------------------------------------- heuristic
const STOPWORDS = new Set(
  'a an the is are was were what when where which who whom how why do does did can could should would will shall may might i you he she it we they my your his her our their this that these those in on at to of for from with by as and or but not no yes if then than so such be been being have has had what\'s when\'s where\'s task tasks note notes due today tomorrow list show tell me give please'.split(' '),
);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Deterministic grounded answer: the 1–2 note sentences with the most
 * keyword overlap with the question. Returns null when nothing matches.
 * A small synonym map covers the demo's own vocabulary (the notes say
 * "submissions close", users ask "deadline") so the fallback still lands
 * on the sentence with the date.
 */
const SYNONYMS = {
  deadline: ['close', 'closes', 'submission', 'submissions', 'due'],
  kickoff: ['starts', 'start', 'begins'],
  prize: ['pool', 'award', 'reward'],
  submit: ['submission', 'submissions'],
};

export function heuristicAnswer(question, notes) {
  const qTokens = new Set(tokenize(question));
  for (const t of [...qTokens]) {
    for (const syn of SYNONYMS[t] || []) qTokens.add(syn);
  }
  if (qTokens.size === 0) return null;
  let best = null;
  for (const note of notes) {
    for (const sentence of splitSentences(note.text)) {
      const tokens = tokenize(sentence);
      const overlap = tokens.filter((t) => qTokens.has(t)).length;
      if (overlap > 0 && (!best || overlap > best.overlap)) {
        best = { overlap, sentence, title: note.title };
      }
    }
  }
  if (!best) return null;
  return { answer: best.sentence, source: best.title };
}

/**
 * Answer a question grounded in the given Notion notes.
 * Returns { answer, source, layer, provider? }.
 * `tasks` is optional; when the question is about today's tasks the
 * deterministic task list answers it without any LLM call.
 */
export async function answerQuestion(question, notes, tasks = []) {
  const q = String(question || '').trim();
  if (!q) throw new Error('empty question');

  // Deterministic path: "what is due today?" is answered from the task
  // list, not from a model — it cannot hallucinate a due date.
  if (/due (today|tonight)|tasks? (today|due)|what('| i)s (due|on) (today|my list)|my tasks/i.test(q)) {
    const today = new Date().toISOString().slice(0, 10);
    const open = tasks.filter((t) => t.status !== 'done');
    const dueToday = open.filter((t) => !t.due || t.due <= today);
    const lines = dueToday.length
      ? dueToday.map((t) => `• ${t.title}`).join(' ')
      : 'Nothing due today.';
    const doneCount = tasks.filter((t) => t.status === 'done').length;
    return {
      answer: `${lines} (${dueToday.length} due today, ${doneCount} done.)`,
      source: 'Tasks',
      layer: 'tasks',
    };
  }

  const context = notes
    .filter((n) => n.text && n.text.trim())
    .map((n) => `[${n.title}]\n${n.text}`)
    .join('\n\n');
  if (!context) {
    return { answer: 'No notes found to answer from.', source: null, layer: 'heuristic' };
  }

  const messages = [
    {
      role: 'system',
      content:
        'Answer ONLY from the notes below. If the notes do not contain the answer, say so in one sentence. Keep the answer to at most 2 short sentences. Do not invent dates, amounts, or names.',
    },
    { role: 'user', content: `Notes:\n${context}\n\nQuestion: ${q}` },
  ];

  const tried = [];
  for (const provider of PROVIDERS) {
    tried.push(provider.name);
    try {
      const { text, servedBy } = await callProvider(provider, messages);
      return { answer: text, source: 'notes', layer: 'llm', provider: provider.name, model: servedBy };
    } catch (err) {
      console.warn(`[llm] ${provider.name} exhausted: ${String(err?.message || err).slice(0, 100)}`);
    }
  }

  const h = heuristicAnswer(q, notes);
  if (h) {
    return { answer: h.answer, source: h.title, layer: 'heuristic', providersTried: tried };
  }
  return {
    answer: 'I could not find that in your notes.',
    source: null,
    layer: 'heuristic',
    providersTried: tried,
  };
}

/** One-line AI summary of today's tasks (heuristic when no LLM). */
export async function summarizeTasks(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  const open = tasks.filter((t) => t.status !== 'done');
  const dueToday = open.filter((t) => !t.due || t.due <= today);
  const done = tasks.filter((t) => t.status === 'done').length;
  const fallback = `${dueToday.length} due today · ${done} done · ${open.length - dueToday.length} upcoming`;
  if (open.length === 0) return done ? 'All tasks done.' : 'No tasks.';
  // Keep the summary deterministic for the glasses display: the counts
  // are the summary. An LLM rephrase would add latency and risk on a
  // 576x288 screen, so the heuristic line IS the summary.
  return fallback;
}

export function llmStatus() {
  return {
    chain: [...PROVIDERS.map((p) => p.name), 'heuristic'],
    providers: PROVIDERS.map((p) => ({ name: p.name, model: p.model })),
  };
}
