import { config } from '../config.js';
import { pool } from '../db.js';
import { provisionOrg } from '../sfbridge.js';
import { RECONNECT_MESSAGE, SalesforceClient } from './client.js';
import { ensureNotificationType } from './notify.js';

// After a user connects an org we finish everything ourselves, so the customer only clicks "Connect":
// 1. install/upgrade the Nimbus package, 2. allow callouts to us, 3. write the signed-connection
// settings, 4. give the connecting user the Nimbus User permission set.

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
  if (config.sourceOrgIds.includes(rows[0]?.sf_org_id)) {
    // The package's own development org can't install it; the components must be deployed there from source.
    const has = await sf.toolingQuery("SELECT Id FROM LightningComponentBundle WHERE DeveloperName = 'crmAgentsPanel' LIMIT 1");
    if (!has.records.length) throw new Error('This is the org the Nimbus package is built in, so it cannot be installed here. Deploy the package source to it (sf project deploy start --source-dir force-app), then click Retry setup.');
    return;
  }
  const installed = await sf.toolingQuery<{ SubscriberPackageVersion?: { Id: string } }>(
    `SELECT SubscriberPackageVersion.Id FROM InstalledSubscriberPackage WHERE SubscriberPackageId = '${config.subscriberPackageId}'`,
  );
  if (installed.records[0]?.SubscriberPackageVersion?.Id === config.packageVersionId) return;

  await status(tenantId, 'installing', 'Installing the Nimbus package in your org (usually 1–3 minutes)…');
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
      if (attempt >= 40 || !/INVALID_CROSS_REFERENCE_KEY/.test(String(e))) throw e;
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

export async function ensureRemoteSite(sf: SalesforceClient) {
  const origin = new URL(config.bridgeUrl).origin;
  const metadata = {
    url: origin,
    isActive: true,
    disableProtocolSecurity: false,
    description: 'Lets the Nimbus package call the Nimbus platform.',
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
  // The connected user uses the panel like everyone else, and records agent activity (Integration).
  const ps = await sf.query("SELECT Id, Name FROM PermissionSet WHERE Name IN ('CRMagents_User', 'CRMagents_Integration')");
  const ids = (ps.records as { Id: string }[]).map((r) => r.Id);
  if (!ids.length) return;
  const has = new Set(((await sf.query(`SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId IN ('${ids.join("','")}')`)).records as { PermissionSetId: string }[]).map((r) => r.PermissionSetId));
  const missing = ids.filter((id) => !has.has(id));
  if (missing.length) await sf.saveMany(missing.map((id) => ({ kind: 'create' as const, sobject: 'PermissionSetAssignment', fields: { AssigneeId: userId, PermissionSetId: id } })));
}

/** Runs in the background; progress is visible in tenants.setup_status / setup_message. */
export async function setupOrg(tenantId: string): Promise<void> {
  if (running.has(tenantId)) return;
  running.add(tenantId);
  try {
    await status(tenantId, 'installing', 'Checking your org…');
    const sf = await SalesforceClient.forTenant(tenantId);
    // Login is all Nimbus needs: data, writes and triggers work over the API. Prove access with one query.
    await sf.query('SELECT Id FROM User LIMIT 1');
    // Bell notifications for approvals work in every org, with or without the package.
    await ensureNotificationType(tenantId, sf).catch(() => undefined);
    const { rows } = await pool.query('select use_package from tenants where id=$1', [tenantId]);
    if (rows[0]?.use_package) {
      // Optional add-on: the record-page panel and Flow action live in the package.
      await ensurePackage(tenantId, sf);
      await status(tenantId, 'configuring', 'Connecting the Agent Panel to Nimbus…');
      await provisionOrg(tenantId); // also allows the address in Remote Site Settings
      await ensurePermission(tenantId, sf);
      await status(tenantId, 'ready', 'Ready. Nimbus is installed in Salesforce: add the Agent Panel to pages and the Ask Nimbus button to layouts.');
    } else {
      await status(tenantId, 'ready', 'Ready. Nothing was installed in your org.');
    }
  } catch (e) {
    await status(tenantId, 'error', friendly(e)).catch(() => {});
  } finally {
    running.delete(tenantId);
  }
}


/** Give every active Salesforce user the Nimbus User permission set (explicit admin action). */
export async function grantAccessToAll(tenantId: string): Promise<{ granted: number; total: number }> {
  const sf = await SalesforceClient.forTenant(tenantId);
  const ps = await sf.query("SELECT Id FROM PermissionSet WHERE Name = 'CRMagents_User' LIMIT 1");
  const psId = (ps.records[0] as { Id?: string } | undefined)?.Id;
  if (!psId) throw new Error('Install Nimbus in Salesforce first.');
  const users = (await sf.query("SELECT Id FROM User WHERE IsActive = true AND UserType = 'Standard' LIMIT 2000")).records as { Id: string }[];
  const has = new Set(((await sf.query(`SELECT AssigneeId FROM PermissionSetAssignment WHERE PermissionSetId = '${psId}' LIMIT 5000`)).records as { AssigneeId: string }[]).map((r) => r.AssigneeId));
  // Up to 200 assignments per call; users whose license can't have it are simply skipped.
  const todo = users.filter((u) => !has.has(u.Id));
  const res = todo.length ? await sf.saveMany(todo.map((u) => ({ kind: 'create' as const, sobject: 'PermissionSetAssignment', fields: { AssigneeId: u.Id, PermissionSetId: psId } }))) : [];
  return { granted: res.filter((r) => r.ok).length, total: users.length };
}
