import type Anthropic from '@anthropic-ai/sdk';
import type { DescribeField, SalesforceClient } from '../salesforce/client.js';
import { recordsToTable } from '../salesforce/table.js';
import { hitsToText, searchKnowledge } from '../knowledge/store.js';

export interface Tool {
  def: Anthropic.Tool;
  write: boolean; // writes need to be explicitly enabled on the agent
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
