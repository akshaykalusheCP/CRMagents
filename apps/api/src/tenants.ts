import { pool } from './db.js';

export async function accountOf(tenantId: string): Promise<string> {
  const { rows } = await pool.query('select account_id from tenants where id = $1', [tenantId]);
  if (!rows[0]) throw new Error('Unknown tenant');
  return rows[0].account_id;
}
