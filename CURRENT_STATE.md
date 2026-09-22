# CURRENT_STATE — 2026-09-22
## Hito autorizado
HITO 0 Bootstrap aprobado por el usuario e integrado en `main` mediante PR #1 el 2026-09-21.
Rama de origen: `astra/hito-0-bootstrap`. Merge: `f9a02bb150b424d9cf0a47b741496c997b7bc085`.
HITO 1 aprobado por el usuario e integrado en `main` mediante PR #4 el 2026-09-22.
Rama de origen: `astra/hito-1-identidad-rls`. Merge: `ffd12c689824886abd8ba6f1e836057fc43ee9a8`.
HITO 2 no autorizado ni iniciado.

## Entregado en H0
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
En H0 no había pruebas SQL/RLS/Auth/kiosco reales. La evidencia de H1 figura más abajo.

## Límites registrados al cierre de H0
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
ESTADO: PASS — H1 aprobado por el usuario y PR #4 integrado en `main`, incluidas las correcciones SEC-H1-01 y AUD-H1-01.
Rama: `astra/hito-1-identidad-rls`, base `39ff3e041e49396fa177e13a0b2e4ebbef034da6`.

Entregado: Supabase local CLI 2.117.0 / PostgreSQL 17; migración de organizaciones,
membresías, empleados sin email, vínculo Auth opcional, roles y FK compuestas; RLS/FORCE RLS,
GRANT mínimos, helpers técnicos, bootstrap privado, transferencia OWNER atómica, revocación,
invitaciones ligadas a identidad verificada/tenant/rol y TTL. Auditoría e idempotencia para
mutaciones H1, bloqueo por organización y versiones. No motor horario ni UI.
Contrato y comandos reproducibles: `supabase/README.md`.

Evidencia ejecutada el 2026-09-22, commit de código `08a7f79a89328f3c4ad5e2d116e1def35b03338a`:
- [Database H1, run 35695686230](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35695686230): PASS.
  Runner Ubuntu 24.04, Supabase CLI 2.117.0, PostgreSQL 17.6.1.167, GoTrue 2.196.0,
  PostgREST 16.2 y Storage 1.72.1. `supabase start` y `supabase db reset --local --no-seed`
  aplican la migración desde vacío; no seed ni base remota.
  `supabase test db`: **85 pruebas SQL/pgTAP PASS**, dos organizaciones × tres roles,
  RLS/FORCE, anon, FK/UUID/join/RPC cruzados, mínimo OWNER, transferencia y revocación.
  `python3 tests/integration/h1.py`: **92 comprobaciones reales PASS**, cuentas sintéticas
  creadas en GoTrue, login real y JWT usados contra PostgREST y Storage. Invitaciones de un uso,
  expiración/identidad/emisor; identidad con roles distintos en dos tenants; 12 requests iguales
  con un único recibo/audit; 12 versiones concurrentes con un ganador; fallo audit revierte datos
  y recibo; revocación que toma el lock primero rechaza la escritura en espera y el JWT anterior.
  Contenedores destruidos con `supabase stop --no-backup` al finalizar.
- [CI general, run 35695686271](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35695686271): PASS.
  npm ci, typecheck, lint, **21 tests**, build, sintaxis shell y whitespace.
- Entorno de edición sin Docker/PostgreSQL: DB ejecutada realmente en CI, no aquí.
  `npm ci && npm run check`, `bash -n scripts/*.sh`, `git diff --check`: PASS local.

Fallos previos corregidos y revalidados: atributos de roles compatibles con el usuario de
migraciones de Supabase; acceso a Auth mediante dos adaptadores privados de lectura (ver SECURITY);
fixture OWNER con constraint diferida; proveedor email/password activo con signup público
bloqueado. Ningún test desactivado ni RLS/Auth simulado en JavaScript.
El commit posterior de cierre solo actualiza este documento; los Checks del PR registran
además la ejecución automática sobre ese commit.

Límites: solo stack local efímero CI, datos sintéticos. No proyecto Supabase remoto, producción,
secretos GitHub, envío de invitaciones, kiosco, informes ni diseño visual. Baja tenant bloquea
JWT previo por RLS/RPC; no revoca sesiones globales de otras organizaciones. Backup DB sigue bloqueado.

## Revisión SEC-H1-01 / AUD-H1-01
Segunda migración: capacidad de tenant protegida por xid8/backend/principal, sin GUC como
fuente de autorización; escritor ordinario sin acceso global. Guard solo lee identidad/invitaciones
y emite contexto; bootstrap y aceptación tienen roles separados, NOLOGIN/NOBYPASSRLS, políticas
acotadas y GRANT específicos. Scope ordinario no puede cambiar de tenant dentro de la transacción.
Los contextos de transacciones finalizadas nunca autorizan otra transacción; se limpian al siguiente bind.
Auditoría before/after de role, active, membership_id y versiones; transferencia con ambas membresías.
Sin email, token, nombre ni payload completo. Pruebas negativas del rol técnico y de función
intencionadamente sin filtro; reconstrucción exclusiva desde audit en SQL y REST real.
Evidencia de las correcciones ejecutada el 2026-09-22, código `43a2b6f418aca4d0a353773ae84c3d03262810f7`:
- [Database H1, run 35729889526, intento 2](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35729889526/attempts/2): PASS.
  `supabase start` y `supabase db reset --local --no-seed` aplican ambas migraciones desde vacío.
  **106 tests SQL/pgTAP PASS**: 85 existentes y 21 de los hallazgos; sin contexto no hay lectura,
  GUC falsificada no autoriza, writer no fabrica/borra contexto ni cambia de tenant, lectura/INSERT/
  UPDATE/movimiento de fila cruzados bloqueados incluso con identidad miembro de ambos tenants.
  Una función SECURITY DEFINER intencionadamente sin filtro sigue limitada por RLS.
  Audit permite reconstruir dos cambios consecutivos de role/active y vínculo, además de ambas
  partes de la transferencia OWNER; replay no duplica evidencia.
  **102 comprobaciones de integración real PASS**: Auth/GoTrue, JWT, PostgREST, Storage,
  concurrencia, revocación y rollback; reconstrucción audit por REST sin leer la entidad actual.
  Stack local efímero y datos sintéticos; contenedores destruidos al finalizar.
- [CI general, run 35729889498](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35729889498): PASS,
  21 tests, typecheck, lint, build, shell y whitespace.
- Fallos intermedios resueltos: permiso CREATE temporal para cambiar propietario del trigger;
  USAGE de extensions concedido al writer solo dentro de la transacción de fixtures pgTAP y
  revertido con ROLLBACK. El primer intento del run final falló antes de tests por puerto 54324
  ocupado en el runner; el segundo completó toda la validación sin cambiar código ni omitir tests.
El commit posterior solo registra estas evidencias. Los Checks del PR muestran además la nueva
validación automática sobre ese último commit. H1 aprobado e integrado posteriormente por autorización expresa del usuario; H2 no iniciado.

## HITO 2 — motor horario (en validación)
Autorizado por el usuario. Rama `astra/hito-2-motor-horario`, base `4ce37bda1e02124def77e0c6e89e2d069e65df21`.
ESTADO: BLOCKED — pendiente de ejecutar y superar CI real; no se declara PASS local.
Migración aditiva: políticas/asignaciones inmutables, proyección inicial transaccional,
sesiones/eventos, record_time_event, estado operativo, idempotencia/auditoría atómicas,
locks compatibles con H1, RLS/FK, reloj único tras lock y CLOCK_REGRESSION.
H1 permanece intacto. Sin H3, kiosco, informes, UI, PWA, producción ni datos reales.
Pruebas nuevas SQL y Auth/REST real; h2.py ejecuta primero la suite completa H1.
CI reconstruye desde vacío y destruye el stack al terminar. Evidencia pendiente.

## Siguiente paso
Completar validación H2 y revisión del PR. No hacer merge ni iniciar H3.
