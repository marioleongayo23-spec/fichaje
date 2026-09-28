import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx|css)$/.test(name) ? [path] : [];
  });
}
const files = sources('src').map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('frontend source guards', () => {
  it('never renders backend data as HTML or evaluates code', () => {
    for (const { path, text } of files) {
      expect(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/.test(text), path).toBe(false);
    }
  });
  it('contains no server credentials, service role or pepper', () => {
    for (const { path, text } of files) {
      expect(/service_role|sb_secret_[A-Za-z0-9]|SERVICE_ROLE|pepper|KIOSK_(PEPPER|NETWORK_SECRET|DATABASE_URL|AUTH_PROVISION_KEY)|postgres(ql)?:\/\//i.test(text), path).toBe(false);
    }
  });
  it('reads only public VITE_ configuration', () => {
    const names = new Set(files.flatMap(({ text }) => text.match(/VITE_[A-Z_]+/g) ?? []));
    expect([...names].sort()).toEqual(['VITE_EXPORT_LINK_URL', 'VITE_KIOSK_GATEWAY_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
    const example = readFileSync('.env.example', 'utf8').split('\n').filter((l) => /^VITE_/.test(l));
    expect(example.every((line) => /^VITE_[A-Z_]+=(\/[a-z/-]*)?$/.test(line))).toBe(true);
  });
  it('touches browser storage only for Auth sessions and the kiosk device identifiers', () => {
    const users = files.filter(({ text }) => /localStorage|sessionStorage|indexedDB/.test(text)).map(({ path }) => path).sort();
    expect(users).toEqual(['src/App.tsx', 'src/kiosk/KioskApp.tsx', 'src/lib/storage.ts']);
    expect(files.some(({ text }) => /sessionStorage|indexedDB/.test(text))).toBe(false);
  });
  it('never logs from application code', () => {
    for (const { path, text } of files) expect(/console\./.test(text), path).toBe(false);
  });
});

describe('artefact secret scanner', () => {
  it('flags secret-shaped content and passes clean files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    try {
      writeFileSync(join(dir, 'clean.js'), 'const prefix = `sb_publishable_`; export default prefix;');
      expect(() => execFileSync('node', ['scripts/scan_secrets.mjs', dir], { stdio: 'pipe' })).not.toThrow();
      writeFileSync(join(dir, 'leak.js'), `const k = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJlLXN5bnRoZXRpYw";`);
      expect(() => execFileSync('node', ['scripts/scan_secrets.mjs', dir], { stdio: 'pipe' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags OPS-02 secret shapes (built at runtime) without flagging the signer path itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-ops-'));
    const scan = () => execFileSync('node', ['scripts/scan_secrets.mjs', dir], { stdio: 'pipe' });
    try {
      writeFileSync(join(dir, 'clean.js'), "if (!url.startsWith('/object/sign/')) deny();");
      expect(scan).not.toThrow();
      const shapes = [
        'AGE-SECRET-KEY-1' + 'Q'.repeat(58),
        'gh' + 'p_' + 'a1B2'.repeat(9),
        '/object/sign/fichaje-evidence/org/job.zip?' + 'token=' + 'x'.repeat(40),
        'OPS_REPAIR' + '_DSN',
      ];
      for (const [index, shape] of shapes.entries()) {
        writeFileSync(join(dir, `leak-${index}.txt`), shape);
        expect(scan).toThrow();
        rmSync(join(dir, `leak-${index}.txt`));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
