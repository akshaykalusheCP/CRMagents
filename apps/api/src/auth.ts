import { accountPlan, isPlatformAdmin, limitReached, trialEnd } from './plans.js';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { roleAtLeast } from '@crmagents/shared';
import { pool } from './db.js';
import { sendMail } from './mailer.js';
import { clearLimit, overLimit } from './ratelimit.js';
import { requiredRole } from './roles.js';
import { requiredFeature, requireFeature, type PlanError } from './plans.js';
import { audit } from './trust/audit.js';
import { createResetToken, resetEmail, resetLink } from './team.js';

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
  await pool.query('update users set last_login_at=now() where id=$1', [userId]);
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

const password = z.string().min(10, 'Password must be at least 10 characters').max(200);
const credentials = z.object({ email: z.string().email().max(200), password });

// Reachable without a session.
const PUBLIC = new Set(['/api/contact', '/api/sales-inquiry', '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/forgot', '/api/auth/reset', '/api/auth/accept']);
const isPublic = (path: string) => PUBLIC.has(path) || path.startsWith('/api/auth/invite/');

export function registerAuth(app: FastifyInstance) {
  app.post('/api/auth/signup', async (req, reply) => {
    if (await overLimit(`signup|${req.ip}`, 10, 3600)) return reply.code(429).send({ error: 'Too many sign-ups from this address. Try again later.' });
    const b = credentials.extend({ accountName: z.string().trim().min(1, 'Company name is required').max(100), plan: z.enum(['basic', 'plus', 'pro']).optional() }).parse(req.body);
    const email = b.email.trim().toLowerCase();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const exists = await client.query('select 1 from users where lower(email)=$1', [email]);
      if (exists.rowCount) { await client.query('rollback'); return reply.code(409).send({ error: 'An account with this email already exists' }); }
      const acc = await client.query("insert into accounts (name, plan, trial_ends_at, requested_plan, plan_set_by, plan_updated_at) values ($1, 'basic', $2, $3, 'sign-up trial', now()) returning id",
        [b.accountName, trialEnd(), b.plan && b.plan !== 'basic' ? b.plan : null]);
      const u = await client.query(
        "insert into users (account_id, email, password_hash, role) values ($1,$2,$3,'owner') returning id",
        [acc.rows[0].id, email, await hashPassword(b.password)],
      );
      await client.query("insert into plan_history (account_id, from_plan, to_plan, changed_by, reason) values ($1, null, 'basic', 'sign-up', $2)",
        [acc.rows[0].id, b.plan && b.plan !== 'basic' ? `14-day trial; picked ${b.plan} on the pricing page` : '14-day trial']);
      await client.query('commit');
      await createSession(reply, u.rows[0].id);
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = credentials.parse(req.body);
    const email = b.email.trim().toLowerCase();
    // Password guessing: 8 tries per email and address, and 30 per email from anywhere, per 15 minutes.
    if (await overLimit(`login|${email}|${req.ip}`, 8, 900) || await overLimit(`login|${email}`, 30, 900)) return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    const { rows } = await pool.query('select id, account_id, password_hash from users where lower(email)=$1', [email]);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = await verifyPassword(b.password, rows[0]?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    if (!rows[0] || !ok) {
      if (rows[0]) await audit(rows[0].account_id, email, 'Failed sign-in (wrong password)', { ip: req.ip });
      return reply.code(401).send({ error: 'Invalid email or password' });
    }
    await audit(rows[0].account_id, email, 'Signed in', { ip: req.ip });
    await clearLimit(`login|${email}|${req.ip}`);
    await createSession(reply, rows[0].id);
    return { ok: true };
  });

  // Forgotten password: always the same answer, so it does not reveal who has a login.
  app.post('/api/auth/forgot', async (req) => {
    const { email } = z.object({ email: z.string().trim().email('Enter a valid email').max(200) }).parse(req.body);
    const e = email.toLowerCase();
    if (await overLimit(`forgot|${req.ip}`, 10, 3600) || await overLimit(`forgot|${e}`, 3, 3600)) return { ok: true };
    const { rows } = await pool.query('select id, account_id from users where lower(email)=$1', [e]);
    if (rows[0]) await sendMail(rows[0].account_id, { to: e, ...resetEmail(resetLink(await createResetToken(rows[0].id))) });
    return { ok: true };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(100), password }).parse(req.body);
    if (await overLimit(`reset|${req.ip}`, 20, 900)) return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    const { rows } = await pool.query(
      'update password_resets set used_at=now() where token_hash=$1 and used_at is null and expires_at > now() returning user_id', [sha(b.token)]);
    if (!rows[0]) return reply.code(400).send({ error: 'This reset link has expired or was already used. Ask for a new one.' });
    await pool.query('update users set password_hash=$2 where id=$1', [rows[0].user_id, await hashPassword(b.password)]);
    const { rows: who } = await pool.query('select account_id, email from users where id=$1', [rows[0].user_id]);
    if (who[0]) await audit(who[0].account_id, who[0].email, 'Reset their password with a link', { ip: req.ip });
    // Everyone signed in with the old password is signed out.
    await pool.query('delete from sessions where user_id=$1', [rows[0].user_id]);
    await createSession(reply, rows[0].user_id);
    return { ok: true };
  });

  // Invitations: see who invited you, then set a password to join.
  app.get('/api/auth/invite/:token', async (req, reply) => {
    const { rows } = await pool.query(
      `select i.email, i.role, i.invited_by as "invitedBy", a.name as "accountName" from invites i join accounts a on a.id = i.account_id
       where i.token_hash=$1 and i.accepted_at is null and i.expires_at > now()`, [sha((req.params as { token: string }).token)]);
    if (!rows[0]) return reply.code(404).send({ error: 'This invitation has expired or was already used. Ask for a new one.' });
    return rows[0];
  });

  app.post('/api/auth/accept', async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(100), password }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        'update invites set accepted_at=now() where token_hash=$1 and accepted_at is null and expires_at > now() returning account_id, email, role', [sha(b.token)]);
      if (!rows[0]) { await client.query('rollback'); return reply.code(400).send({ error: 'This invitation has expired or was already used. Ask for a new one.' }); }
      const exists = await client.query('select 1 from users where lower(email)=$1', [rows[0].email]);
      if (exists.rowCount) { await client.query('rollback'); return reply.code(409).send({ error: 'This email already has a CRMagents login. Sign in instead.' }); }
      // The plan's people limit (people already in; this invitation was counted when it was sent).
      const p = await accountPlan(rows[0].account_id);
      const { rows: n } = await client.query('select count(*)::int n from users where account_id=$1', [rows[0].account_id]);
      if (p.trialEnded || limitReached(p.plan, 'users', n[0].n)) { await client.query('rollback'); return reply.code(402).send({ error: 'This workspace has no room for another person on its plan. Ask its admin to upgrade.' }); }
      const u = await client.query('insert into users (account_id, email, password_hash, role) values ($1,$2,$3,$4) returning id',
        [rows[0].account_id, rows[0].email, await hashPassword(b.password), rows[0].role]);
      await client.query('commit');
      await audit(rows[0].account_id, rows[0].email, 'Joined the workspace', { target: `as ${rows[0].role}`, ip: req.ip });
      await createSession(reply, u.rows[0].id);
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    return { ok: true };
  });

  // Change your own password (signed in).
  app.post('/api/auth/password', async (req, reply) => {
    const b = z.object({ current: z.string().max(200), password }).parse(req.body);
    const u = req.user!;
    if (await overLimit(`pw|${u.id}`, 8, 900)) return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    const { rows } = await pool.query('select password_hash from users where id=$1', [u.id]);
    if (!rows[0] || !(await verifyPassword(b.current, rows[0].password_hash))) return reply.code(400).send({ error: 'Your current password is not right.' });
    await pool.query('update users set password_hash=$2 where id=$1', [u.id, await hashPassword(b.password)]);
    // Other devices are signed out; this one stays.
    await pool.query('delete from sessions where user_id=$1 and token_hash <> $2', [u.id, sha(req.cookies[COOKIE] ?? '')]);
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
    return { ...user, platformAdmin: isPlatformAdmin(user.email) };
  });

  // Everything else under /api requires a session, and tenant-scoped routes require the org to belong to the user's account.
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') || isPublic(path)) return;
    const user = await loadUser(req);
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    req.user = user;
    const need = requiredRole(req.method, req.url);
    if (!roleAtLeast(user.role, need)) {
      return reply.code(403).send({ error: need === 'admin' ? 'Only workspace admins can do this.' : 'Your role can review and approve, but not change agents. Ask an admin for the Builder role.' });
    }
    // The plan: pages and actions that belong to a higher plan answer 402 with what to upgrade to.
    const feature = requiredFeature(req.method, req.url);
    if (feature) {
      try { await requireFeature(user.accountId, feature); } catch (e) {
        const pe = e as PlanError;
        return reply.code(402).send({ error: pe.message, plan: pe.detail });
      }
    }
    const tenantId = (req.params as { tenantId?: string } | undefined)?.tenantId;
    if (tenantId) {
      const { rowCount } = await pool.query('select 1 from tenants where id=$1 and account_id=$2', [tenantId, user.accountId]).catch(() => ({ rowCount: 0 }));
      if (!rowCount) return reply.code(404).send({ error: 'not found' });
    }
  });
}

export { COOKIE };
