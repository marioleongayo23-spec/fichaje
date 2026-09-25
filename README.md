# Fichaje APP
SaaS de registro horario multiempresa. H1-H5 backend aprobado; H6 añade interfaz web y PWA (ver estado).

## Desarrollo
Node 24 LTS y npm 11. `npm ci`, `npm run dev`. `npm run check` ejecuta typecheck, lint, tests y build.
Copiar `.env.example` a `.env.local` únicamente para un futuro entorno local autorizado.
Sin variables la app muestra que el servicio no está configurado. Pruebas de navegador: con Supabase
local arrancado (`supabase/README.md`), Deno y Python, `npx playwright install chromium` y `npm run test:e2e`.
Decisiones de interfaz, PWA y bloqueo de kiosco: [UI y PWA](docs/UI_PWA.md).
Solo URL y publishable key pública pueden llegar al navegador. Nunca service_role ni credenciales PostgreSQL.

## Navegación
- [Estado](CURRENT_STATE.md), [instrucciones](AGENTS.md), [especificación](docs/MASTER_SPEC.md).
- [Roadmap](docs/ROADMAP.md), [arquitectura](docs/ARCHITECTURE.md), [modelo](docs/DATA_MODEL.md).
- [Seguridad](docs/SECURITY.md), [cumplimiento](docs/COMPLIANCE.md).
- [Aceptación](docs/ACCEPTANCE_TESTS.md), [recuperación](docs/RECOVERY.md).

CI sin secretos. Backup del repositorio solo manual; PostgreSQL bloqueado en H0.
