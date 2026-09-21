# CURRENT_STATE — 2026-09-21
## Hito autorizado
HITO 0 Bootstrap aprobado por el usuario e integrado en `main` mediante PR #1 el 2026-09-21.
Rama de origen: `astra/hito-0-bootstrap`. Merge: `f9a02bb150b424d9cf0a47b741496c997b7bc085`.
HITO 1 autorizado por el usuario el 2026-09-21; implementación en `astra/hito-1-identidad-rls`.
No autorizado HITO 2 ni merge de H1.

## Entregado
- Diez documentos de gobierno y diseño coherentes: arquitectura, modelo, roles/RLS, máquina de
  estados, tiempo servidor, inmutabilidad/correcciones, audit, concurrencia/idempotencia y kiosco.
- Contratos de exportación, retención, aceptación, recuperación y roadmap con puertas por hito.
- React + TypeScript + Vite, cliente Supabase lazy, configuración pública validada y texto neutro.
- Lockfile y CI: npm ci, typecheck, lint, tests, build; sin credenciales ni despliegue.
- Backup manual de repo: bundle con historial/refs, snapshot, checksums y rclone opcional.
- Backup PostgreSQL bloqueado incondicionalmente; documentación de conexión/cifrado/restore futuros.

## Evidencia H0
Entorno local Node 24.19.0, npm 11.9.0, Linux.
`npm ci`, `npm run check`, `bash -n scripts/backup_repo.sh scripts/backup_database.sh` y
`git diff --cached --check`: PASS en validación local previa a publicación del PR.
Suite: 21 tests (configuración/render, recuperación real de bundle sintético, shallow/dirty,
fallo de verificación remota, bloqueo DB y contratos de workflows).
El estado ejecutado de GitHub Actions se consulta en Checks del PR; no sustituirlo por resultado local.
No hay pruebas SQL/RLS/Auth/kiosco reales: son criterios para H1-H5, no funcionalidad completada.

## Límites y decisiones pendientes
No base remota, credenciales, Drive, datos personales reales, migraciones aplicadas, diseño visual,
service worker ni configuración Cloudflare/producción. Backup remoto real y restore DB NO ensayados.
Normativa base enlazada y fechada; revisar convenio/sector y requisitos vigentes antes de piloto.
No añadir Secrets ni activar backup DB en este hito. No hacer merge automático.

## OPS-01 — backup online
PASS. PR #2 integrado en `main`. Backup privado generado en cada push a main, diariamente a
01:30 UTC y manualmente; artefacto GitHub conservado 14 días, sin credenciales Google en GitHub.
Primera copia secundaria subida y verificada en `Fichaje APP - BACKUP/01 - Repo Snapshots`.
Artefacto GitHub run 35619934149: SHA-256
`545bd31a02ec4afe66e3c87daa0b89c2297867c992bd2a2d6f837bfa5c5e38a7`.
Checksums internos PASS; bundle restaurado en repositorio vacío y `main` restaurado coincide con
`c177548662735fa257390e6775f2731d7f01fe98`. Copia diaria a Drive programada en ChatGPT a las
05:00 Europe/Madrid. Backup PostgreSQL sigue bloqueado.

## HITO 1 — identidad y aislamiento
ESTADO: BLOCKED hasta disponer de resultados de CI DB real.
Rama: `astra/hito-1-identidad-rls`, base `39ff3e041e49396fa177e13a0b2e4ebbef034da6`.

Entregado: Supabase local CLI 2.117.0 / PostgreSQL 17; migración de organizaciones,
membresías, empleados sin email, vínculo Auth opcional, roles y FK compuestas; RLS/FORCE RLS,
GRANT mínimos, helpers técnicos, bootstrap privado, transferencia OWNER atómica, revocación,
invitaciones ligadas a identidad verificada/tenant/rol y TTL. Auditoría e idempotencia para
mutaciones H1, bloqueo por organización y versiones. No motor horario ni UI.
Contrato y comandos reproducibles: `supabase/README.md`.

Evidencias pendientes: workflow `Database H1`: `supabase start`, `supabase db reset --local
--no-seed`, `supabase test db`, `python3 tests/integration/h1.py`. Fixture SQL con dos
organizaciones × tres roles; integración con GoTrue/JWT/PostgREST/Storage reales y
concurrencia HTTP. Sin mocks RLS/Auth JavaScript. CI H0 también debe seguir verde.
Entorno de edición sin Docker/PostgreSQL; no atribuirle ejecución DB local.

Límites: solo stack local efímero CI, datos sintéticos. No proyecto Supabase remoto, producción,
secretos GitHub, envío de invitaciones, kiosco, informes ni diseño visual. Baja tenant bloquea
JWT previo por RLS/RPC; no revoca sesiones globales de otras organizaciones. Backup DB sigue bloqueado.

## Siguiente paso
Completar evidencias de CI, dejar PR H1 contra main para revisión y detenerse; no merge ni H2.
