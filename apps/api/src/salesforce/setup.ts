import { config } from '../config.js';
import { pool } from '../db.js';
import { provisionOrg } from '../sfbridge.js';
import { RECONNECT_MESSAGE, SalesforceClient } from './client.js';

// After a user connects an org we finish everything ourselves, so the customer only clicks "Connect":
// 1. install/upgrade the CRMagents package, 2. allow callouts to us, 3. write the signed-connection
// settings, 4. give the connecting user the CRMagents User permission set.

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const running = new Set<string>();

async function status(tenantId: string, s: string, message: string) {
  await pool.query('update tenants set setup_status=$2, setup_message=$3 where id=$1', [tenantId, s, message]);
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/INSUFFICIENT_ACCESS|insufficient access|not have permission|Download AppExchange/i.test(msg)) {
    return 'Installing needs a Salesforce admin. Ask an admin to click Connect once for this org; after that anyone can use it.';
  }
  if (/invalid_grant|expired access\/refresh token/i.test(msg)) return RECONNECT_MESSAGE;
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensurePackage(tenantId: string, sf: SalesforceClient) {
  const { rows } = await pool.query('select sf_org_id from tenants where id=$1', [tenantId]);
  if (config.sourceOrgIds.includes(rows[0]?.sf_org_id)) return;
  const installed = await sf.toolingQuery<{ SubscriberPackageVersion?: { Id: string } }>(
    `SELECT SubscriberPackageVersion.Id FROM InstalledSubscriberPackage WHERE SubscriberPackageId = '${config.subscriberPackageId}'`,
  );
  if (installed.records[0]?.SubscriberPackageVersion?.Id === config.packageVersionId) return;

  await status(tenantId, 'installing', 'Installing the CRMagents package in your org (usually 1–3 minutes)…');
  // A freshly released package version can take a few minutes to become installable everywhere;
  // until then Salesforce answers INVALID_CROSS_REFERENCE_KEY, so retry for a while.
  let req: { id: string } | undefined;
  for (let attempt = 0; !req; attempt++) {
    try {
      req = await sf.tooling<{ id: string }>('POST', '/sobjects/PackageInstallRequest', {
        SubscriberPackageVersionKey: config.packageVersionId,
        NameConflictResolution: 'Block',
        SecurityType: 'None', // admins only; users get access through the permission set below
      });
    } catch (e) {
      if (attempt >= 12 || !/INVALID_CROSS_REFERENCE_KEY/.test(String(e))) throw e;
      await sleep(15_000);
    }
  }
  const t0 = Date.now();
  for (;;) {
    await sleep(5000);
    const r = await sf.tooling<{ Status: string; Errors?: { errors?: { message: string }[] } }>(
      'GET', `/sobjects/PackageInstallRequest/${req.id}`,
    );
    // Salesforce returns e.g. SUCCESS even though the picklist is documented as Success.
    const st = String(r.Status).toUpperCase();
    if (st === 'SUCCESS') return;
    if (st === 'ERROR' || st === 'CANCELED') {
      throw new Error(`Package install failed: ${r.Errors?.errors?.map((x) => x.message).join('; ') || r.Status}`);
    }
    if (Date.now() - t0 > INSTALL_TIMEOUT_MS) throw new Error('Package install is taking too long. Try "Retry setup" in a few minutes.');
  }
}

async function ensureRemoteSite(sf: SalesforceClient) {
  const origin = new URL(config.bridgeUrl).origin;
  const metadata = {
    url: origin,
    isActive: true,
    disableProtocolSecurity: false,
    description: 'Lets the CRMagents package call the CRMagents platform.',
  };
  const existing = await sf.toolingQuery<{ Id: string }>("SELECT Id FROM RemoteProxy WHERE SiteName = 'CRMagents_Platform'");
  if (existing.records[0]) {
    await sf.tooling('PATCH', `/sobjects/RemoteProxy/${existing.records[0].Id}`, { Metadata: metadata });
  } else {
    await sf.tooling('POST', '/sobjects/RemoteProxy', { FullName: 'CRMagents_Platform', Metadata: metadata });
  }
}

async function ensurePermission(tenantId: string, sf: SalesforceClient) {
  const { rows } = await pool.query('select sf_user_id from tenants where id=$1', [tenantId]);
  const userId: string | null = rows[0]?.sf_user_id;
  if (!userId) return;
  const ps = await sf.query("SELECT Id FROM PermissionSet WHERE Name = 'CRMagents_User' LIMIT 1");
  const psId = (ps.records[0] as { Id?: string } | undefined)?.Id;
  if (!psId) return;
  const has = await sf.query(`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId = '${psId}' LIMIT 1`);
  if (!has.records.length) await sf.createRecord('PermissionSetAssignment', { AssigneeId: userId, PermissionSetId: psId });
}

/** Runs in the background; progress is visible in tenants.setup_status / setup_message. */
export async function setupOrg(tenantId: string): Promise<void> {
  if (running.has(tenantId)) return;
  running.add(tenantId);
  try {
    await status(tenantId, 'installing', 'Checking your org…');
    const sf = await SalesforceClient.forTenant(tenantId);
    // Login is all CRMagents needs: data, writes and triggers work over the API. Prove access with one query.
    await sf.query('SELECT Id FROM User LIMIT 1');
    const { rows } = await pool.query('select use_package from tenants where id=$1', [tenantId]);
    if (rows[0]?.use_package) {
      // Optional add-on: the record-page panel and Flow action live in the package.
      await ensurePackage(tenantId, sf);
      await status(tenantId, 'configuring', 'Connecting the record-page panel to CRMagents…');
      await ensureRemoteSite(sf);
      await provisionOrg(tenantId);
      await ensurePermission(tenantId, sf);
      await status(tenantId, 'ready', 'Ready, with the record-page panel installed.');
    } else {
      await status(tenantId, 'ready', 'Ready. Nothing was installed in your org.');
    }
  } catch (e) {
    await status(tenantId, 'error', friendly(e)).catch(() => {});
  } finally {
    running.delete(tenantId);
  }
}
