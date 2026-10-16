import type Anthropic from '@anthropic-ai/sdk';
import type { DescribeField, SalesforceClient } from '../salesforce/client.js';
import { recordsToTable } from '../salesforce/table.js';
import { fileText } from '../salesforce/files.js';
import { hitsToText, searchKnowledge } from '../knowledge/store.js';
import { actionContext, actionKey, listOrgActions, parseActionKey, rankActions } from '../salesforce/actions.js';

export interface Tool {
  def: Anthropic.Tool;
  write: boolean; // writes need to be explicitly enabled on the agent
  /** Only for website chat (never offered to internal assistants). */
  publicOnly?: boolean;
  run(sf: SalesforceClient, input: any): Promise<unknown>;
}

const MAX_ROWS = 50;
const MAX_DESCRIBE_FIELDS = 300;
const PICKLIST_DETAIL_UNDER = 15; // show picklist values only when the field list is narrowed down

/** One compact line per field, e.g. "OwnerId: reference(User)" or "Status: picklist [New, Closed]". */
function describeLine(f: DescribeField, withPicklists: boolean): string {
  let t = f.type;
  if (f.type === 'reference' && f.referenceTo?.length) t = `reference(${f.referenceTo.join('|')})`;
  if (withPicklists && f.picklistValues?.length) {
    t += ` [${f.picklistValues.filter((p) => p.active).map((p) => p.value).join(', ')}]`;
  }
  return `${f.name}: ${t}${f.updateable ? '' : ' (read-only)'}`;
}

export const TOOLS: Record<string, Tool> = {
  search_knowledge: {
    write: false,
    def: {
      name: 'search_knowledge',
      description:
        "Search the company's own documents (support guides, policies, product manuals) uploaded to the knowledge base. Returns the best-matching numbered sections with their document title. Use it before giving troubleshooting steps or policy answers, and cite sections as [1], [2]. Search with the key words of the problem (e.g. \"wifi not connecting windows 11\"), not a full sentence.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Key words of what to look up' },
          limit: { type: 'integer', description: 'How many sections (default 4, max 8)' },
        },
        required: ['query'],
      },
    },
    async run(sf, { query, limit }) {
      return hitsToText(await searchKnowledge(sf.accountId, String(query ?? ''), Math.min(Number(limit) || 4, 8)));
    },
  },
  soql_query: {
    write: false,
    def: {
      name: 'soql_query',
      description: `Run a read-only SOQL query against Salesforce. Returns at most ${MAX_ROWS} rows as CSV with a header row. Select only the fields you need and use LIMIT.`,
      input_schema: {
        type: 'object',
        properties: { soql: { type: 'string', description: 'A SOQL SELECT statement' } },
        required: ['soql'],
      },
    },
    async run(sf, { soql }) {
      if (!/^\s*select\s/i.test(soql)) throw new Error('Only SELECT queries are allowed');
      const r = await sf.query(soql);
      const rows = r.records.slice(0, MAX_ROWS);
      const head = `${r.totalSize} row(s)${rows.length < r.totalSize ? `, showing ${rows.length}` : ''}`;
      return rows.length ? `${head} (CSV):\n${recordsToTable(rows)}` : head;
    },
  },
  describe_object: {
    write: false,
    def: {
      name: 'describe_object',
      description:
        'List the fields of a Salesforce object as "ApiName: type" lines. Pass `search` (matches API name or label) to narrow the list; a narrowed list also shows picklist values.',
      input_schema: {
        type: 'object',
        properties: {
          sobject: { type: 'string' },
          search: { type: 'string', description: 'Optional words to filter fields by, e.g. "status" or "revenue"' },
        },
        required: ['sobject'],
      },
    },
    async run(sf, { sobject, search }) {
      let fields = await sf.describe(sobject);
      if (search) {
        const words = String(search).toLowerCase().split(/\s+/).filter(Boolean);
        fields = fields.filter((f) => words.some((w) => f.name.toLowerCase().includes(w) || f.label.toLowerCase().includes(w)));
      }
      const withPicklists = fields.length < PICKLIST_DETAIL_UNDER;
      const lines = fields.slice(0, MAX_DESCRIBE_FIELDS).map((f) => describeLine(f, withPicklists));
      const more = fields.length > MAX_DESCRIBE_FIELDS ? `\n…${fields.length - MAX_DESCRIBE_FIELDS} more; use search to narrow.` : '';
      return `${sobject} (${fields.length} fields)\n${lines.join('\n')}${more}`;
    },
  },
  get_record: {
    write: false,
    def: {
      name: 'get_record',
      description: 'Fetch a single Salesforce record by object API name and Id. Pass `fields` to fetch only what you need.',
      input_schema: {
        type: 'object',
        properties: {
          sobject: { type: 'string' },
          id: { type: 'string' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Optional field API names to return' },
        },
        required: ['sobject', 'id'],
      },
    },
    run: (sf, { sobject, id, fields }) => sf.getRecord(sobject, id, Array.isArray(fields) ? fields : undefined),
  },
  create_record: {
    write: true,
    def: {
      name: 'create_record',
      description: 'Create a Salesforce record.',
      input_schema: {
        type: 'object',
        properties: { sobject: { type: 'string' }, fields: { type: 'object' } },
        required: ['sobject', 'fields'],
      },
    },
    run: (sf, { sobject, fields }) => sf.createRecord(sobject, fields),
  },
  list_files: {
    write: false,
    def: {
      name: 'list_files',
      description: 'List the files attached to a Salesforce record (title, type, size, versionId). Use read_file to read one.',
      input_schema: { type: 'object', properties: { recordId: { type: 'string' } }, required: ['recordId'] },
    },
    async run(sf, { recordId }) {
      const files = await sf.listFiles(String(recordId));
      return files.length ? files.map((f) => `${f.title}.${f.extension} (${Math.ceil(f.size / 1024)} KB) versionId=${f.versionId}`).join('\n') : 'No files on this record.';
    },
  },
  read_file: {
    write: false,
    def: {
      name: 'read_file',
      description: 'Read the text of a file from list_files (PDF, Word, text, CSV, HTML). Long files are cut.',
      input_schema: { type: 'object', properties: { versionId: { type: 'string', description: 'versionId from list_files' }, title: { type: 'string' }, extension: { type: 'string', description: 'e.g. pdf' } }, required: ['versionId'] },
    },
    async run(sf, { versionId, title, extension }) {
      return fileText(sf, { versionId: String(versionId), title: String(title ?? 'file'), extension: String(extension ?? 'pdf').toLowerCase().replace(/^\./, ''), size: 0 });
    },
  },
  open_case: {
    write: true,
    publicOnly: true,
    def: {
      name: 'open_case',
      description: 'Open a support case for the visitor when their problem needs a person. Ask for their name, email and a short description first, and confirm before opening it. Returns the case number to give them.',
      input_schema: {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string' }, subject: { type: 'string' }, description: { type: 'string' } },
        required: ['name', 'email', 'subject', 'description'],
      },
    },
    async run(sf, { name, email, subject, description }) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email ?? ''))) throw new Error('Ask for a valid email address');
      const r = await sf.createRecord('Case', {
        SuppliedName: String(name).slice(0, 80), SuppliedEmail: String(email).slice(0, 80), Origin: 'Web',
        Subject: String(subject).slice(0, 255), Description: String(description).slice(0, 32000),
      });
      const c = await sf.getRecord('Case', r.id, ['CaseNumber']);
      return { caseNumber: (c as { CaseNumber?: string }).CaseNumber };
    },
  },
  case_status: {
    write: false,
    publicOnly: true,
    def: {
      name: 'case_status',
      description: "Look up the status of the visitor's own case. Needs the case number and the email address the case was opened with; both must match.",
      input_schema: { type: 'object', properties: { caseNumber: { type: 'string' }, email: { type: 'string' } }, required: ['caseNumber', 'email'] },
    },
    async run(sf, { caseNumber, email }) {
      const num = String(caseNumber ?? '').replace(/[^0-9]/g, '');
      const mail = String(email ?? '').trim().toLowerCase().replace(/'/g, '');
      if (!num || !mail) throw new Error('Ask for the case number and email');
      const r = await sf.query(`SELECT CaseNumber, Subject, Status, LastModifiedDate, SuppliedEmail, ContactEmail FROM Case WHERE CaseNumber = '${num.padStart(8, '0')}' LIMIT 1`);
      const c = r.records[0] as Record<string, string> | undefined;
      // Same answer whether the case doesn't exist or the email doesn't match: nothing to learn by guessing.
      if (!c || ![c.SuppliedEmail, c.ContactEmail].some((e) => e && e.toLowerCase() === mail)) return 'No case found with that number and email.';
      return { caseNumber: c.CaseNumber, subject: c.Subject, status: c.Status, lastUpdated: c.LastModifiedDate };
    },
  },
  find_org_actions: {
    write: false,
    def: {
      name: 'find_org_actions',
      description: "Find the org's own automations you can run with run_org_action: autolaunched Flows, invocable Apex and standard actions (send email, post to Chatter, submit for approval). Returns each action's key, label, inputs (* = required) and outputs.",
      input_schema: {
        type: 'object',
        properties: { search: { type: 'string', description: 'Words describing what you want to do, e.g. "close case" or "send email"' } },
        required: ['search'],
      },
    },
    async run(sf, { search }) {
      const all = await listOrgActions(sf.tenantId, sf);
      const picked = rankActions(String(search ?? ''), all, 6);
      if (!picked.length) return `No matching actions. Some available: ${all.slice(0, 25).map(actionKey).join(', ')}`;
      return (await actionContext(sf.tenantId, sf, picked)) || 'No describable actions matched.';
    },
  },
  run_org_action: {
    write: true,
    def: {
      name: 'run_org_action',
      description: 'Run one of the org\'s automations found with find_org_actions (e.g. "flow:Close_Case" or "standard:emailSimple") with its inputs. Only run it when the user asked for that outcome.',
      input_schema: {
        type: 'object',
        properties: { action: { type: 'string', description: 'Key from find_org_actions, like flow:Name or apex:Name' }, inputs: { type: 'object' } },
        required: ['action', 'inputs'],
      },
    },
    async run(sf, { action, inputs }) {
      const a = parseActionKey(String(action ?? ''));
      if (!a) throw new Error('Use a key from find_org_actions, like flow:Close_Case');
      return { success: true, outputs: await sf.runAction(a.kind, a.name, inputs ?? {}) };
    },
  },
  run_agent: {
    write: true,
    def: {
      name: 'run_agent',
      description: 'Start one of this workspace\'s CRMagents agents by name, optionally on a record, and return its result (or that it is waiting for approval). Agents that change data still stop for their approvals.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The agent\'s name' },
          recordId: { type: 'string' },
          objectApiName: { type: 'string' },
          input: { type: 'string', description: 'Free text for agents started by hand' },
        },
        required: ['name'],
      },
    },
    async run(sf, { name, recordId, objectApiName, input }) {
      const { pool } = await import('../db.js');
      const { rows } = await pool.query('select id, name from workflows where tenant_id=$1 and lower(name)=lower($2) limit 1', [sf.tenantId, String(name ?? '').trim()]);
      if (!rows[0]) {
        const all = await pool.query('select name from workflows where tenant_id=$1 order by name limit 30', [sf.tenantId]);
        throw new Error(`No agent named "${name}". Agents: ${all.rows.map((r) => r.name).join(', ') || 'none'}`);
      }
      const { startRunAsync } = await import('../engine/service.js');
      const r = await startRunAsync(sf.tenantId, rows[0].id, { recordId, objectApiName, input }, 25_000);
      return { agent: rows[0].name, status: r.status, output: r.output?.slice(0, 4000), approval: r.approval };
    },
  },
  delete_record: {
    write: true,
    def: {
      name: 'delete_record',
      description: 'Delete a Salesforce record (it goes to the Recycle Bin for 15 days). Only when the user clearly asked for it.',
      input_schema: { type: 'object', properties: { sobject: { type: 'string' }, id: { type: 'string' } }, required: ['sobject', 'id'] },
    },
    async run(sf, { sobject, id }) {
      await sf.deleteRecord(String(sobject), String(id));
      return { success: true };
    },
  },
  update_record: {
    write: true,
    def: {
      name: 'update_record',
      description: 'Update fields on an existing Salesforce record.',
      input_schema: {
        type: 'object',
        properties: { sobject: { type: 'string' }, id: { type: 'string' }, fields: { type: 'object' } },
        required: ['sobject', 'id', 'fields'],
      },
    },
    async run(sf, { sobject, id, fields }) {
      await sf.updateRecord(sobject, id, fields);
      return { success: true };
    },
  },
};
