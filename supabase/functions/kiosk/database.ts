// Remote PostgreSQL must fail closed: strict TLS needs both verify-full and the provider CA.
export interface DatabaseTlsOptions { rejectUnauthorized: true; ca: string }

export function databaseTls(url: string, ca: string | undefined, environment: string | undefined): DatabaseTlsOptions | false {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('CONFIG_REQUIRED'); }
  const mode = parsed.searchParams.get('sslmode');
  const remote = environment === 'staging' || environment === 'production';
  if (remote && mode !== 'verify-full') throw new Error('CONFIG_REQUIRED');
  if (mode !== 'verify-full') return false;
  if (!ca || !ca.includes('-----BEGIN CERTIFICATE-----') || !ca.includes('-----END CERTIFICATE-----')) throw new Error('CONFIG_REQUIRED');
  return { rejectUnauthorized: true, ca };
}
