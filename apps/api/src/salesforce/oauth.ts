import { requireRoom } from '../plans.js';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { getSfConfig } from '../settings.js';
import { forgetPersonToken, primeAccessToken } from './client.js';

// Phase 1: in-memory. Move to Postgres/Redis before running more than one instance.
interface OwnApp { clientId: string; clientSecret?: string }
const pending = new Map<string, { verifier: string; loginUrl: string; accountId: string; own?: OwnApp; person?: { userId: string; tenantId: string; orgId: string } }>();

export const redirectUri = () => `${config.publicUrl}/oauth/callback`;
const b64url = (b: Buffer) => b.toString('base64url');

// Only real Salesforce hosts may receive the user's login, so this cannot be used for phishing redirects.
const SF_HOST = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(salesforce\.com|force\.com|salesforce-setup\.com)$/i;

export function normalizeLoginUrl(raw: string): string {
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const origin = `https://${u.hostname}`;
  if (!SF_HOST.test(origin)) throw new Error('Enter a Salesforce domain, e.g. mycompany.my.salesforce.com');
  return origin;
}

export function validateOwnApp(o: OwnApp): OwnApp {
  const clientId = o.clientId.trim();
  if (!/^[A-Za-z0-9._]{20,200}$/.test(clientId)) throw new Error('That does not look like a Salesforce Consumer Key');
  return { clientId, clientSecret: o.clientSecret?.trim() || undefined };
}

export async function buildAuthorizeUrl(accountId: string, sandbox = false, customUrl?: string, own?: OwnApp): Promise<string> {
  const sf = own ? { clientId: own.clientId, clientSecret: own.clientSecret ?? '', loginUrl: (await getSfConfig(accountId).catch(() => null))?.loginUrl ?? 'https://login.salesforce.com' } : await getSfConfig(accountId);
  const loginUrl = customUrl ? normalizeLoginUrl(customUrl) : sandbox ? 'https://test.salesforce.com' : sf.loginUrl;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  pending.set(state, { verifier, loginUrl, accountId, own });
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: sf.clientId,
    redirect_uri: redirectUri(),
    scope: 'api refresh_token',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Always show the Salesforce login screen so a different org/user can be chosen, even if this browser is already logged in.
    prompt: 'login consent',
    state,
  });
  return `${loginUrl}/services/oauth2/authorize?${p}`;
}

/** A person links their own Salesforce login to an org the workspace already connected (logs in on that org's domain). */
export async function buildPersonAuthorizeUrl(accountId: string, tenantId: string, userId: string): Promise<string> {
  const { rows } = await pool.query('select sf_org_id, sf_instance_url, sf_client_id, sf_client_secret_enc from tenants where id=$1 and account_id=$2', [tenantId, accountId]);
  if (!rows[0]) throw Object.assign(new Error('Unknown org'), { statusCode: 404 });
  const t = rows[0];
  const own = t.sf_client_id ? { clientId: t.sf_client_id as string, clientSecret: t.sf_client_secret_enc ? decrypt(t.sf_client_secret_enc) : undefined } : undefined;
  const clientId = own?.clientId ?? (await getSfConfig(accountId)).clientId;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  const loginUrl = normalizeLoginUrl(t.sf_instance_url);
  pending.set(state, { verifier, loginUrl, accountId, own, person: { userId, tenantId, orgId: t.sf_org_id } });
  const p = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri(), scope: 'api refresh_token', code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login consent', state });
  return `${loginUrl}/services/oauth2/authorize?${p}`;
}

export type CallbackResult = { kind: 'org'; tenantId: string } | { kind: 'person'; tenantId: string };

export async function handleCallback(code: string, state: string): Promise<CallbackResult> {
  const ctx = pending.get(state);
  if (!ctx) throw new Error('Unknown or expired OAuth state');
  pending.delete(state);
  const sf = ctx.own ? { clientId: ctx.own.clientId, clientSecret: ctx.own.clientSecret ?? '' } : await getSfConfig(ctx.accountId);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: sf.clientId,
    redirect_uri: redirectUri(),
    code_verifier: ctx.verifier,
  });
  if (sf.clientSecret) body.set('client_secret', sf.clientSecret);

  const res = await fetch(`${ctx.loginUrl}/services/oauth2/token`, { method: 'POST', body });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const tok = (await res.json()) as {
    refresh_token: string;
    instance_url: string;
    id: string;
    access_token: string;
  };

  // The identity URL ends with /<orgId>/<userId>
  const [orgId, userId] = new URL(tok.id).pathname.split("/").slice(-2);
  const idRes = await fetch(tok.id, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  const ident = idRes.ok ? ((await idRes.json()) as { username?: string }) : {};

  if (ctx.person) {
    // Must be the same org the workspace connected; otherwise drop the token straight away.
    if (orgId !== ctx.person.orgId) {
      await fetch(`${tok.instance_url}/services/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ token: tok.refresh_token }) }).catch(() => undefined);
      throw new Error('That login is for a different Salesforce org. Log in with your user in the org this workspace is connected to.');
    }
    await pool.query(
      `insert into person_sf_links (user_id, tenant_id, sf_user_id, sf_username, refresh_token_enc) values ($1,$2,$3,$4,$5)
       on conflict (user_id, tenant_id) do update set sf_user_id=excluded.sf_user_id, sf_username=excluded.sf_username, refresh_token_enc=excluded.refresh_token_enc, created_at=now()`,
      [ctx.person.userId, ctx.person.tenantId, userId, ident.username ?? null, encrypt(tok.refresh_token)]);
    forgetPersonToken(ctx.person.tenantId, ctx.person.userId);
    return { kind: 'person', tenantId: ctx.person.tenantId };
  }

  const { rows: known } = await pool.query('select 1 from tenants where account_id=$1 and sf_org_id=$2', [ctx.accountId, orgId]);
  if (!known.length) await requireRoom(ctx.accountId, 'orgs');
  const { rows } = await pool.query(
    `insert into tenants (account_id, sf_org_id, sf_instance_url, sf_username, refresh_token_enc, sf_client_id, sf_client_secret_enc, sf_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (account_id, sf_org_id) do update
       set sf_instance_url = excluded.sf_instance_url,
           sf_username = excluded.sf_username,
           refresh_token_enc = excluded.refresh_token_enc,
           sf_client_id = excluded.sf_client_id,
           sf_client_secret_enc = excluded.sf_client_secret_enc,
           sf_user_id = excluded.sf_user_id
     returning id`,
    [ctx.accountId, orgId, tok.instance_url, ident.username ?? null, encrypt(tok.refresh_token), ctx.own?.clientId ?? null, ctx.own?.clientSecret ? encrypt(ctx.own.clientSecret) : null, userId],
  );
  const tenantId = rows[0].id as string;
  primeAccessToken(tenantId, tok.access_token);
  return { kind: 'org', tenantId };
}
