import { requireRoom } from './plans.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { roleAtLeast } from '@crmagents/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { sendMail } from './mailer.js';

// The people in a workspace: invite by email with a role, change roles, remove people, and give someone a
// password reset link. Admins (and owners) only. Links are single-use; only their hash is stored.

const INVITE_DAYS = 7;
const RESET_HOURS = 2;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const forbidden = (msg = 'Only admins can manage the team.') => Object.assign(new Error(msg), { statusCode: 403 });

export const inviteLink = (token: string) => `${config.webUrl.replace(/\/$/, '')}/?invite=${token}`;
export const resetLink = (token: string) => `${config.webUrl.replace(/\/$/, '')}/?reset=${token}`;

/** A new password reset link for a user (valid 2 hours; older unused links stop working). */
export async function createResetToken(userId: string) {
  const token = randomBytes(32).toString('base64url');
  await pool.query('delete from password_resets where user_id=$1', [userId]);
  await pool.query('insert into password_resets (token_hash, user_id, expires_at) values ($1,$2,$3)',
    [sha(token), userId, new Date(Date.now() + RESET_HOURS * 3600_000)]);
  return token;
}

export function resetEmail(link: string) {
  return {
    subject: 'Reset your CRMagents password',
    text: `Someone asked to reset the password for this CRMagents login.\n\nSet a new password: ${link}\n\nThe link works once, for ${RESET_HOURS} hours. If you didn't ask for it, ignore this email: your password stays the same.`,
  };
}

async function owners(accountId: string) {
  const { rows } = await pool.query("select count(*)::int n from users where account_id=$1 and role='owner'", [accountId]);
  return rows[0].n as number;
}

export function registerTeam(app: FastifyInstance) {
  app.get('/api/team', async (req) => {
    const u = req.user!;
    const { rows: users } = await pool.query(
      'select id, email, role, created_at as "createdAt", last_login_at as "lastLoginAt" from users where account_id=$1 order by created_at', [u.accountId]);
    const admin = roleAtLeast(u.role, 'admin');
    const invites = admin ? (await pool.query(
      `select id, email, role, invited_by as "invitedBy", expires_at as "expiresAt", created_at as "createdAt"
       from invites where account_id=$1 and accepted_at is null and expires_at > now() order by created_at desc`, [u.accountId])).rows : [];
    return { me: u.id, canManage: admin, users, invites };
  });

  app.post('/api/team/invites', async (req) => {
    const u = req.user!;
    const b = z.object({ email: z.string().trim().email('Enter a valid email').max(200), role: z.enum(['admin', 'builder', 'approver']) }).parse(req.body);
    const email = b.email.toLowerCase();
    const taken = await pool.query('select account_id from users where lower(email)=$1', [email]);
    if (taken.rows[0]) {
      throw Object.assign(new Error(taken.rows[0].account_id === u.accountId ? 'They are already in this workspace.' : 'This email already has a CRMagents login in another company.'), { statusCode: 409 });
    }
    // A new invitation replaces an open one for the same email, so it doesn't count twice.
    const { rows: open } = await pool.query('select 1 from invites where account_id=$1 and lower(email)=$2 and accepted_at is null and expires_at > now()', [u.accountId, email]);
    if (!open.length) await requireRoom(u.accountId, 'users');
    const token = randomBytes(32).toString('base64url');
    // One open invitation per email: a new one replaces the old.
    await pool.query('delete from invites where account_id=$1 and lower(email)=$2 and accepted_at is null', [u.accountId, email]);
    const { rows } = await pool.query(
      'insert into invites (account_id, email, role, token_hash, invited_by, expires_at) values ($1,$2,$3,$4,$5,$6) returning id',
      [u.accountId, email, b.role, sha(token), u.email, new Date(Date.now() + INVITE_DAYS * 86_400_000)]);
    const link = inviteLink(token);
    const emailed = await sendMail(u.accountId, {
      to: email,
      subject: `${u.email} invited you to ${u.accountName} on CRMagents`,
      text: `${u.email} invited you to join ${u.accountName} on CRMagents as ${b.role === 'admin' ? 'an admin' : `a ${b.role}`}.\n\nAccept and set your password: ${link}\n\nThe link works for ${INVITE_DAYS} days.`,
    });
    return { id: rows[0].id, link, emailed };
  });

  app.delete('/api/team/invites/:id', async (req) => {
    await pool.query('delete from invites where id=$1 and account_id=$2', [(req.params as { id: string }).id, req.user!.accountId]);
    return { ok: true };
  });

  app.put('/api/team/users/:id', async (req) => {
    const u = req.user!;
    const { id } = req.params as { id: string };
    const { role } = z.object({ role: z.enum(['owner', 'admin', 'builder', 'approver']) }).parse(req.body);
    const { rows } = await pool.query('select role from users where id=$1 and account_id=$2', [id, u.accountId]);
    if (!rows[0]) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    // Only an owner makes or unmakes owners; the workspace always keeps at least one.
    if ((role === 'owner' || rows[0].role === 'owner') && u.role !== 'owner') throw forbidden('Only an owner can change who is an owner.');
    if (rows[0].role === 'owner' && role !== 'owner' && (await owners(u.accountId)) <= 1) throw forbidden('The workspace needs at least one owner.');
    await pool.query('update users set role=$3 where id=$1 and account_id=$2', [id, u.accountId, role]);
    // Their open sessions pick up the new role on the next request (it is read per request).
    return { ok: true };
  });

  app.delete('/api/team/users/:id', async (req) => {
    const u = req.user!;
    const { id } = req.params as { id: string };
    if (id === u.id) throw forbidden('You cannot remove yourself.');
    const { rows } = await pool.query('select role from users where id=$1 and account_id=$2', [id, u.accountId]);
    if (!rows[0]) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    if (rows[0].role === 'owner' && u.role !== 'owner') throw forbidden('Only an owner can remove an owner.');
    await pool.query('delete from users where id=$1 and account_id=$2', [id, u.accountId]); // sessions go with it
    return { ok: true };
  });

  app.post('/api/team/users/:id/reset-link', async (req) => {
    const u = req.user!;
    const { id } = req.params as { id: string };
    const { rows } = await pool.query('select email, role from users where id=$1 and account_id=$2', [id, u.accountId]);
    if (!rows[0]) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    if (rows[0].role === 'owner' && u.role !== 'owner' ) throw forbidden('Only an owner can reset an owner\'s password.');
    const link = resetLink(await createResetToken(id));
    const emailed = await sendMail(u.accountId, { to: rows[0].email, ...resetEmail(link) });
    return { link, emailed };
  });
}
