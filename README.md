# Fichaje APP
SaaS de registro horario multiempresa. HITO 0: documentación y bootstrap, sin producto operativo.

## Desarrollo
Node 24 LTS y npm 11. `npm ci`, `npm run dev`. `npm run check` ejecuta typecheck, lint, tests y build.
Copiar `.env.example` a `.env.local` únicamente para un futuro entorno local autorizado.
El bootstrap funciona sin variables ni conexión Supabase; no contiene autenticación ni fichaje implementados.
Solo URL y publishable key pública pueden llegar al navegador. Nunca service_role ni credenciales PostgreSQL.

## Navegación
- [Estado](CURRENT_STATE.md), [instrucciones](AGENTS.md), [especificación](docs/MASTER_SPEC.md).
- [Roadmap](docs/ROADMAP.md), [arquitectura](docs/ARCHITECTURE.md), [modelo](docs/DATA_MODEL.md).
- [Seguridad](docs/SECURITY.md), [cumplimiento](docs/COMPLIANCE.md).
- [Aceptación](docs/ACCEPTANCE_TESTS.md), [recuperación](docs/RECOVERY.md).

CI sin secretos. Backup del repositorio solo manual; PostgreSQL bloqueado en H0.
