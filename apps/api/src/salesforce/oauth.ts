import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { getSfConfig } from '../settings.js';
import { primeAccessToken } from './client.js';

// Phase 1: in-memory. Move to Postgres/Redis before running more than one instance.
interface OwnApp { clientId: string; clientSecret?: string }
const pending = new Map<string, { verifier: string; loginUrl: string; accountId: string; own?: OwnApp }>();

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

export async function handleCallback(code: string, state: string): Promise<string> {
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
  return tenantId;
}
