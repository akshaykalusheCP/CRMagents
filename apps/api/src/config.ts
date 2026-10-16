function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3001',
  // Where Salesforce calls us (Apex callouts). Defaults to publicUrl; set it to a tunnel in local dev.
  bridgeUrl: process.env.BRIDGE_URL || process.env.PUBLIC_URL || 'http://localhost:3101',
  databaseUrl: req('DATABASE_URL'),
  tokenEncKey: Buffer.from(req('TOKEN_ENC_KEY'), 'hex'),
  // Orgs where the package source is deployed directly (our own dev/publisher orgs): never install the package there.
  sourceOrgIds: (process.env.SOURCE_ORG_IDS ?? '00DQy00000Li8r5MAB').split(',').map((s) => s.trim()),
  subscriberPackageId: process.env.SUBSCRIBER_PACKAGE_ID ?? '033Qy000000R05ZIAS',
  packageVersionId: process.env.PACKAGE_VERSION_ID ?? '04tQy000000aB8DIAU',
  webUrl: process.env.WEB_URL ?? 'http://localhost:5173',
  sf: { apiVersion: 'v67.0' },
  model: process.env.MODEL ?? 'claude-opus-5-5',
  // Model that turns plain-English requests into workflow plans (structured output keeps it on real fields).
  // Business summaries and analytics questions: correctness matters most, so the strongest default model.
  insightsModel: process.env.INSIGHTS_MODEL ?? process.env.MODEL ?? 'claude-opus-5-5',
  builderModel: process.env.BUILDER_MODEL ?? 'claude-haiku-5-5',
};

if (config.tokenEncKey.length !== 32) {
  throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
}
