import type { Role } from '@crmagents/shared';

// Which role a change needs. Reading is open to everyone in the workspace; changes are checked here, by path, in
// one place (auth.ts calls it for every /api request), so a new route is "builder" unless listed.

const ADMIN: RegExp[] = [
  /^\/api\/settings$/, /^\/api\/plan\/request$/, /^\/api\/billing\//, /^\/api\/oauth\/start$/, /^\/api\/team(\/|$)/, /^\/api\/impact\/assumptions$/,
  /^\/api\/knowledge\/sources(\/|$)/,
  /^T$/, // disconnecting an org (DELETE /api/tenants/:id)
  /^T\/(grant-access|package|provision|setup)$/, /^T\/salesforce\/pages\//,
  /^T\/agents\/[^/]+\/public$/, /^T\/rules(\/|$)/,
  /^T\/workflows\/[^/]+\/(autonomy|allowed-fields)$/,
];

const APPROVER: RegExp[] = [
  /^\/api\/auth\//, /^\/api\/me\//, /^\/api\/alerts(\/|$)/, /^\/api\/memories(\/[^/]+)?$/, /^\/api\/platform\//, /^T\/conversations\/[^/]+$/, /^\/api\/knowledge\/search$/,
  /^T\/runs\/[^/]+\/decision$/, /^T\/record-suggestions\/[^/]+$/, /^T\/suggestions\/[^/]+\/dismiss$/,
  /^T\/insights\/(ask|summary)$/, /^T\/dashboards\/(run|drill)$/,
  /^T\/agents\/[^/]+\/run$/, /^T\/workflows\/[^/]+\/feedback$/,
];

/** The least role allowed to make this request. Pure; tested. */
export function requiredRole(method: string, url: string): Role {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'approver';
  const path = url.split('?')[0].replace(/^\/api\/tenants\/[0-9a-f-]{36}/i, 'T');
  if (ADMIN.some((r) => r.test(path))) return 'admin';
  if (APPROVER.some((r) => r.test(path))) return 'approver';
  return 'builder';
}
