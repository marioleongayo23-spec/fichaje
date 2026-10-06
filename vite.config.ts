import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// Public files copied from /public that belong to the installable shell.
export const PUBLIC_SHELL = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

// Injects the exact precache list into sw.js. Only built shell files and the
// public icons/manifest are listed: never API, Auth, Storage or gateway URLs.
function serviceWorker(): Plugin {
  return {
    name: 'fichaje-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sw = bundle['sw.js'];
        if (!sw || sw.type !== 'chunk') throw new Error('Service worker chunk missing');
        const built = Object.keys(bundle).filter((file) => file !== 'sw.js' && file !== 'index.html' && !file.endsWith('.map')).map((file) => `/${file}`);
        const precache = ['/', ...built.sort(), ...PUBLIC_SHELL];
        if (precache.some((path) => /^\/(rest|auth|storage|functions|gateway)(\/|$)/.test(path))) throw new Error('Forbidden path in precache');
        const version = createHash('sha256').update(JSON.stringify(precache)).update(
          Object.values(bundle).map((item) => item.type === 'chunk' ? item.code : String(item.source)).join('\n')).digest('hex').slice(0, 16);
        sw.code = sw.code.replace('__FICHAJE_PRECACHE__', JSON.stringify(precache).replace(/'/g, "\\'")).replace('__FICHAJE_VERSION__', version);
      },
    },
  };
}

// Strict CSP for the built app: scripts and styles only from the same origin,
// network only to the configured Supabase origin (and gateways if absolute).
export function contentSecurityPolicy(env: Record<string, string>): string {
  const origins = new Set<string>();
  for (const key of ['VITE_SUPABASE_URL', 'VITE_KIOSK_GATEWAY_URL', 'VITE_EXPORT_LINK_URL', 'VITE_BILLING_GATEWAY_URL']) {
    const value = env[key]?.trim();
    if (value && /^https?:\/\//.test(value)) origins.add(new URL(value).origin);
  }
  return ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    `connect-src 'self'${[...origins].map((o) => ` ${o}`).join('')}`, "manifest-src 'self'", "worker-src 'self'",
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-src 'none'"].join('; ');
}

// H7 Cloudflare Pages static policy. Headers for every static response (the
// /gateway functions set their own no-store headers): the same CSP plus
// frame-ancestors (header only), HSTS, no default CORS on static files, no
// referrer, no powerful features, no indexing, revalidated HTML and immutable
// hashed assets. The function route table only admits /gateway/*.
export const PAGES_ROUTES = { version: 1, include: ['/gateway/*'], exclude: [] as string[] };

export function pagesHeaders(env: Record<string, string>): string {
  return ['/*',
    '  ! Access-Control-Allow-Origin',
    '  ! Referrer-Policy',
    `  Content-Security-Policy: ${contentSecurityPolicy(env)}; frame-ancestors 'none'`,
    '  Strict-Transport-Security: max-age=31536000',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Resource-Policy: same-origin',
    '  X-Robots-Tag: noindex, nofollow',
    '  Cache-Control: no-cache',
    '/assets/*',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=31536000, immutable',
    ''].join('\n');
}

// Written after the bundle, so neither file can enter the service worker precache.
function pagesPolicy(env: Record<string, string>): Plugin {
  return {
    name: 'fichaje-pages-policy',
    apply: 'build',
    writeBundle(options) {
      if (!options.dir) throw new Error('Output directory missing');
      writeFileSync(join(options.dir, '_headers'), pagesHeaders(env));
      writeFileSync(join(options.dir, '_routes.json'), JSON.stringify(PAGES_ROUTES) + '\n');
    },
  };
}

function csp(env: Record<string, string>): Plugin {
  return {
    name: 'fichaje-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(env)}" />`),
  };
}

// Local development and E2E only: same-origin paths proxied to server-only
// functions running on loopback. Production routing is decided at deployment.
function gatewayProxy(): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {};
  const kiosk = process.env.FICHAJE_KIOSK_GATEWAY_TARGET;
  const exportLink = process.env.FICHAJE_EXPORT_LINK_TARGET;
  const billing = process.env.FICHAJE_BILLING_GATEWAY_TARGET;
  if (kiosk) proxy['/gateway/kiosk'] = { target: kiosk, rewrite: (path) => path.replace(/^\/gateway\/kiosk/, '') };
  // The signer answers at its root; OPS-02 health paths stay reachable same-origin.
  if (exportLink) proxy['/gateway/export-link'] = { target: exportLink, rewrite: (path) => path.replace(/^\/gateway\/export-link/, '') || '/' };
  if (billing) proxy['/gateway/billing'] = { target: billing, rewrite: (path) => path.replace(/^\/gateway\/billing/, '') || '/' };
  return proxy;
}

// OPS-02 release identity of the built artifact (public, bounded). It is only
// written into index.html for the release gate: the browser never sends it.
export function releaseId(value = process.env.FICHAJE_RELEASE): string {
  return value && /^[0-9A-Za-z.+_-]{1,64}$/.test(value) ? value : 'dev';
}

export function withReleaseMeta(html: string, release = releaseId()): string {
  return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta name="fichaje-release" content="${releaseId(release)}" />`);
}

function releaseMeta(): Plugin {
  return { name: 'fichaje-release', apply: 'build', transformIndexHtml: (html) => withReleaseMeta(html) };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), serviceWorker(), csp(env), releaseMeta(), pagesPolicy(env)],
    build: {
      rolldownOptions: {
        input: { index: 'index.html', sw: 'src/pwa/sw.ts' },
        output: {
          entryFileNames: (chunk) => chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
          codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/ }] },
        },
      },
    },
    server: { proxy: gatewayProxy() },
    preview: { proxy: gatewayProxy(), headers: { 'Service-Worker-Allowed': '/' } },
  };
});
