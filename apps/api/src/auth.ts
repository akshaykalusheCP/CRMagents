import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { pool } from './db.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface SessionUser { id: string; email: string; accountId: string; accountName: string; role: string }
declare module 'fastify' {
  interface FastifyRequest { user?: SessionUser }
}

const COOKIE = 'crmagents_session';
const SESSION_DAYS = 14;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function createSession(reply: FastifyReply, userId: string) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await pool.query('insert into sessions (token_hash, user_id, expires_at) values ($1,$2,$3)', [sha(token), userId, expires]);
  reply.setCookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https://'), path: '/', expires,
  });
}

export async function loadUser(req: FastifyRequest): Promise<SessionUser | undefined> {
  const token = req.cookies[COOKIE];
  if (!token) return undefined;
  const { rows } = await pool.query(
    `select u.id, u.email, u.role, a.id as account_id, a.name as account_name
     from sessions s join users u on u.id = s.user_id join accounts a on a.id = u.account_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha(token)],
  );
  const r = rows[0];
  return r && { id: r.id, email: r.email, role: r.role, accountId: r.account_id, accountName: r.account_name };
}

// Crude in-memory throttle for password attempts (per email+IP). Use Redis when running several instances.
const attempts = new Map<string, { n: number; reset: number }>();
function throttled(key: string): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < now) { attempts.set(key, { n: 1, reset: now + 15 * 60_000 }); return false; }
  return ++a.n > 8;
}

const credentials = z.object({ email: z.string().email().max(200), password: z.string().min(10, 'Password must be at least 10 characters').max(200) });

export function registerAuth(app: FastifyInstance) {
  app.post('/api/auth/signup', async (req, reply) => {
    const b = credentials.extend({ accountName: z.string().trim().min(1, 'Company name is required').max(100) }).parse(req.body);
    const email = b.email.trim().toLowerCase();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const exists = await client.query('select 1 from users where lower(email)=$1', [email]);
      if (exists.rowCount) { await client.query('rollback'); return reply.code(409).send({ error: 'An account with this email already exists' }); }
      const acc = await client.query('insert into accounts (name) values ($1) returning id', [b.accountName]);
      const u = await client.query(
        "insert into users (account_id, email, password_hash, role) values ($1,$2,$3,'owner') returning id",
        [acc.rows[0].id, email, await hashPassword(b.password)],
      );
      await client.query('commit');
      await createSession(reply, u.rows[0].id);
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = credentials.parse(req.body);
    const email = b.email.trim().toLowerCase();
    if (throttled(`${email}|${req.ip}`)) return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    const { rows } = await pool.query('select id, password_hash from users where lower(email)=$1', [email]);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await verifyPassword(b.password, rows[0]?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!rows[0] || !ok) return reply.code(401).send({ error: 'Invalid email or password' });
    await createSession(reply, rows[0].id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await pool.query('delete from sessions where token_hash=$1', [sha(token)]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = await loadUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    return user;
  });

  // Everything else under /api requires a session, and tenant-scoped routes require the org to belong to the user's account.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || path === '/api/auth/signup' || path === '/api/auth/login' || path === '/api/auth/logout' || path === '/api/auth/me') return;
    const user = await loadUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = user;
    const tenantId = (req.params as { tenantId?: string } | undefined)?.tenantId;
    if (tenantId) {
      const { rowCount } = await pool.query('select 1 from tenants where id=$1 and account_id=$2', [tenantId, user.accountId]).catch(() => ({ rowCount: 0 }));
      if (!rowCount) return reply.code(404).send({ error: 'not found' });
    }
  });
}

export { COOKIE };
