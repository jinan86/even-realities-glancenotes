# GlanceNotes — Notion tasks + notes on Even G2 glasses

GlanceNotes shows your Notion tasks on Even G2 glasses and answers
questions from your own notes, grounded in what Notion actually says.
Built for the **Even Realities Hackathon** (Heads Up), track
**04 · AI Assistants & Work**.

- **Home (glasses):** your top 3 tasks today + a one-line summary
  ("2 due today · 1 done"). Scroll picks a task, one tap marks it done.
- **Ask (glasses):** preset questions via tap, or type a question on the
  companion page — the answer comes from your Notion pages, with its
  source shown.
- **Write:** add a task from the companion page, confirm with one tap
  on G2. Marking done is one tap on G2.
- **Exit:** double-tap on the home page shows an exit-confirm dialog —
  never a silent exit.

## What existed before 23 Nov 2026

Only the official Even Hub minimal template
(`even-realities/evenhub-templates`, route `minimal`) plus its libraries
(`@evenrealities/even_hub_sdk`, Vite, TypeScript, the Even Hub CLI and
simulator). No GlanceNotes code existed before the 23 Nov 15:00 WIB
kickoff; everything in `src/`, `backend/` and this README was written
during build week. The free LLM chain
(100milionseek → OpenRouter → Coarena → heuristic) reuses the pattern
proven in the author's earlier Sentinel project — no model, key, or
service from that project is bundled here.

## Architecture

```
[Notion API] <- token, server-side only - [Backend Node + Express :3001]
        ^                                        |  /api/tasks, /api/ask,
        |                                        |  /api/tasks/add|done
[Companion page (type Q / add task)]             [G2 app: Vite + TS + SDK]
                                                       |  1 text container
                                                       v
                                               [Simulator / Even G2]
```

- **Backend** (`backend/server.js`): Express, port 3001. Dual Notion
  adapter with one interface — `mock` (sample data, no token) and `live`
  (`@notionhq/client`, `backend/notion-live.js`).
- **LLM** (`backend/llm.js`): free chain, in order — 100milionseek →
  OpenRouter (`baidu/ernie-5.5-flash-preview:free`, `max_tokens` 4096;
  Ernie reasons ~1000 tokens before answering) → Coarena → heuristic
  (keyword matching over fetched Notion content). Keys only via env or
  the Secure Vault surrogate, never in the repo. Secrets are never sent
  through these proxies — only the question and your own note text.
- **G2 app** (`src/main.ts`): one text container per page (max 4, exactly
  one `isEventCapture`), pages rebuilt with `rebuildPageContainer`.

## Run (simulator)

```bash
npm install

# Terminal 1 — backend (mock adapter, no token needed)
npm run backend        # http://localhost:3001

# Terminal 2 — G2 app dev server
npm run dev            # http://localhost:5173

# Terminal 3 — simulator (global 0.9.5, under Xvfb)
xvfb-run -a evenhub-simulator --automation-port 9898 http://localhost:5173
```

Then drive it headlessly via the automation port:

```bash
curl -s http://localhost:9898/api/ping            # pong
curl -s http://localhost:9898/api/console | head  # bridge + page logs
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"action":"click"}' http://localhost:9898/api/input
```

Known simulator quirks (verified in Phase 0):
- `/api/screenshot/glasses` returns a solid-green framebuffer with no
  text — use `xwd` window screenshots for visual proof.
- Vite HMR does **not** update the glasses display — restart the
  simulator after display code changes.
- Always run the simulator under `xvfb-run -a`; read `DISPLAY` /
  `XAUTHORITY` from `/proc/<simulator-pid>/environ`, never assume `:99`.
- Never use `pkill -f` in this shell — it kills the shell itself. Use
  `kill <PID>`.

## Live Notion (when the token arrives)

```bash
NOTION_ADAPTER=live NOTION_TOKEN=<integration token> \
  NOTION_TASKS_DB_ID=<Tasks database id> npm run backend
```

The token is provided via Secure Vault, never pasted in chat, never
committed. The live adapter was written from the Notion API docs and has
**not yet been verified** against the real workspace — first live run
must check `GET /api/tasks` output, because the Tasks database column
names were not visible without the token. Property reading is tolerant
(first property of the matching type wins).

## Honest notes

- **Voice / STT is out of demo scope, by design.** The G2 SDK only
  exposes raw microphone audio; speech-to-text needs a paid service and
  no reliable free STT key exists for this demo. GlanceNotes is tap-first
  ("act with one tap"), which is a first-class G2 input. A mic → Whisper
  path is designed follow-up work, not something demoed.
- **Mock vs live:** until the Notion token is wired, the demo runs on
  sample data that mirrors the real "Tasks" database + 3 sample pages.
  The UI, tap flows, and grounded-answer logic are identical; only the
  data source changes.
- **Money safety:** read-only demo data plus local task writes. No user
  funds, no mainnet, no payments. No API key or secret is committed.

## Pack (optional)

```bash
npm run pack   # produces a .ehpk from app.json + dist
```

## Hackathon

- Event: Heads Up: Even Realities Hackathon — https://dorahacks.io/hackathon/even-realities/detail
- Track: 04 AI Assistants & Work · Package: `com.jinan.glancenotes`
- Submit by 30 Nov 2026 02:59 WIB (target 27 Nov) · Demo Day 3 Dec 2026
  (finalists may demo remotely)
