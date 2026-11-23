// Live Notion adapter — same interface as notion-mock.js, backed by
// @notionhq/client.
//
// Requires env:
//   NOTION_TOKEN       integration token (server-side only, never in repo)
//   NOTION_TASKS_DB_ID the "Tasks" database id shared with the integration
//
// NOT YET VERIFIED against zee's workspace: the token had not been
// provided when this adapter was written (23 Nov 2026), so it was built
// from the Notion API docs and tested only for import/startup. Property
// reading is tolerant on purpose: zee's "Tasks" database column names
// were not visible without the token, so title/status/due are picked from
// the first property of the matching type instead of a hardcoded name.
// First live run must check GET /api/tasks output and fix the mapping
// if the columns differ.
//
// The token is used ONLY here, server-side. It is never sent to the
// glasses app, the companion page, or any LLM provider.
import { Client } from '@notionhq/client';

function plainText(richText) {
  return (richText || []).map((t) => t.plain_text || '').join('');
}

function firstPropOf(page, type) {
  const props = page.properties || {};
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === type) return { name, prop };
  }
  return null;
}

function readTitle(page) {
  const found = firstPropOf(page, 'title');
  return found ? plainText(found.prop.title) : '(untitled)';
}

function readStatus(page) {
  const status = firstPropOf(page, 'status');
  if (status) return String(status.prop.status?.name || 'open').toLowerCase();
  const select = firstPropOf(page, 'select');
  if (select) return String(select.prop.select?.name || 'open').toLowerCase();
  const checkbox = firstPropOf(page, 'checkbox');
  if (checkbox) return checkbox.prop.checkbox ? 'done' : 'open';
  return 'open';
}

function readDue(page) {
  const date = firstPropOf(page, 'date');
  return date?.prop?.date?.start || null;
}

function blocksToText(blocks) {
  const lines = [];
  for (const b of blocks || []) {
    const text = plainText(b[b.type]?.rich_text);
    if (text.trim()) lines.push(text.trim());
  }
  return lines.join('\n');
}

export function createLiveAdapter({ token, tasksDbId }) {
  if (!token) throw new Error('NOTION_TOKEN is not set');
  if (!tasksDbId) throw new Error('NOTION_TASKS_DB_ID is not set');
  const notion = new Client({ auth: token });

  return {
    name: 'live',

    async listTasks() {
      const res = await notion.databases.query({
        database_id: tasksDbId,
        sorts: [{ property: 'Due', direction: 'ascending' }],
      }).catch(async (err) => {
        // 'Due' may not be the date column name; retry without sorting.
        if (String(err?.message || '').includes('not a property')) {
          return notion.databases.query({ database_id: tasksDbId });
        }
        throw err;
      });
      return res.results.map((page) => ({
        id: page.id,
        title: readTitle(page),
        status: readStatus(page),
        due: readDue(page),
        source: 'Tasks',
      }));
    },

    async listNotes() {
      const res = await notion.search({
        filter: { property: 'object', value: 'page' },
        page_size: 20,
      });
      const notes = [];
      for (const page of res.results) {
        // Skip the Tasks database rows themselves; notes are standalone pages.
        if (page.parent?.type === 'database_id') continue;
        const title = readTitle(page);
        let text = '';
        try {
          const blocks = await notion.blocks.children.list({ block_id: page.id, page_size: 50 });
          text = blocksToText(blocks.results);
        } catch {
          text = '';
        }
        notes.push({ id: page.id, title, text });
      }
      return notes;
    },

    async addTask(title) {
      // The title property name is discovered from one existing row.
      const sample = await notion.databases.query({ database_id: tasksDbId, page_size: 1 });
      const samplePage = sample.results[0];
      const titleName = samplePage ? firstPropOf(samplePage, 'title')?.name : null;
      if (!titleName) throw new Error('Tasks database has no title property');
      const page = await notion.pages.create({
        parent: { database_id: tasksDbId },
        properties: { [titleName]: { title: [{ text: { content: String(title).trim().slice(0, 120) } }] } },
      });
      return { id: page.id, title: String(title).trim().slice(0, 120), status: 'open', due: null, source: 'Tasks' };
    },

    async markDone(id) {
      const page = await notion.pages.retrieve({ page_id: id });
      const status = firstPropOf(page, 'status');
      if (status) {
        await notion.pages.update({
          page_id: id,
          properties: { [status.name]: { status: { name: 'Done' } } },
        });
      } else {
        const select = firstPropOf(page, 'select');
        if (select) {
          await notion.pages.update({
            page_id: id,
            properties: { [select.name]: { select: { name: 'Done' } } },
          });
        } else {
          const checkbox = firstPropOf(page, 'checkbox');
          if (checkbox) {
            await notion.pages.update({
              page_id: id,
              properties: { [checkbox.name]: { checkbox: true } },
            });
          } else {
            throw new Error('Tasks database has no status/select/checkbox property to mark done');
          }
        }
      }
      const updated = await notion.pages.retrieve({ page_id: id });
      return { id, title: readTitle(updated), status: 'done', due: readDue(updated), source: 'Tasks' };
    },
  };
}
