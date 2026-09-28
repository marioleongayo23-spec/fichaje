// Fails when built frontend files or test artefacts contain secret-shaped
// material. Usage: node scripts/scan_secrets.mjs <dir|file>...  Prints only
// file paths and rule names, never the matched value.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RULES = [
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['supabase-secret-key', /sb_secret_[A-Za-z0-9_-]{10,}/],
  ['service-role', /service_role/i],
  ['server-env-name', /SUPABASE_SERVICE_ROLE_KEY|KIOSK_PEPPER|KIOSK_NETWORK_SECRET|KIOSK_AUTH_PROVISION_KEY|KIOSK_DATABASE_URL|EXPORT_DATABASE_URL/],
  ['pepper', /\bpepper\b/i],
  ['postgres-credential', /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // OPS-02: backup keys, CI/API tokens, signed Storage URLs and operator DSN names.
  ['age-secret-key', /AGE-SECRET-KEY-1[0-9A-Z]{20,}/],
  ['github-token', /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['signed-url', /\/object\/sign\/[^\s"'`]+[?&]token=[A-Za-z0-9._-]{16,}/],
  ['ops-env-name', /OPS_(MONITOR|REVIEWER|REPAIR|OPERATOR)_DSN|OPS_ALERT_ROUTE_(PAGER|TICKET)/],
  // H7: edge ingress secret, alert route credentials, platform tokens and backup configuration names.
  ['h7-env-name', /FICHAJE_INGRESS_SECRET|OPS_PAGERDUTY_ROUTING_KEY|OPS_GITHUB_TOKEN|CLOUDFLARE_API_TOKEN|SUPABASE_ACCESS_TOKEN|FICHAJE_BACKUP_(PGSERVICE|AGE_RECIPIENT|DEST|CA)/],
  ['supabase-access-token', /\bsbp_[A-Za-z0-9]{30,}/],
];

function files(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => files(join(path, name)));
}

const targets = process.argv.slice(2);
if (!targets.length) { console.error('usage: scan_secrets.mjs <path>...'); process.exit(2); }
let findings = 0, scanned = 0;
for (const file of targets.flatMap(files)) {
  scanned++;
  const text = readFileSync(file, 'latin1');
  for (const [rule, pattern] of RULES) {
    if (pattern.test(text)) { findings++; console.error(`SECRET_PATTERN ${rule} in ${file}`); }
  }
}
console.log(`scanned ${scanned} files, ${findings} findings`);
process.exit(findings ? 1 : 0);
