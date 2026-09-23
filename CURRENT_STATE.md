# CURRENT_STATE — 2026-09-23
## Hito autorizado
HITO 0 Bootstrap aprobado por el usuario e integrado en `main` mediante PR #1 el 2026-09-21.
Rama de origen: `astra/hito-0-bootstrap`. Merge: `f9a02bb150b424d9cf0a47b741496c997b7bc085`.
HITO 1 aprobado por el usuario e integrado en `main` mediante PR #4 el 2026-09-22.
Rama de origen: `astra/hito-1-identidad-rls`. Merge: `ffd12c689824886abd8ba6f1e836057fc43ee9a8`.
HITO 2 aprobado por el usuario e integrado en `main` mediante PR #5 el 2026-09-22.
Rama de origen: `astra/hito-2-motor-horario`. Merge: `e4edd0d451627d6cd6e25aafc31819a77ee76116`.
HITO 3 aprobado por el usuario e integrado en `main` mediante PR #7 el 2026-09-23.
Rama de origen: `astra/hito-3-correcciones`. Merge: `a848c1c5adef50ada215d7362089db5da3ebf3f8`.
HITO 4 no autorizado ni iniciado.

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
validación automática sobre ese último commit. H1 aprobado e integrado posteriormente por autorización expresa del usuario; H2 se autorizó después.

## HITO 2 — motor horario
ESTADO: PASS — HITO 2 aprobado por el usuario y PR #5 integrado en `main`.
Rama `astra/hito-2-motor-horario`, base `4ce37bda1e02124def77e0c6e89e2d069e65df21`.
PR [#5](https://github.com/marioleongayo23-spec/fichaje/pull/5) integrado en `main`. H3 no estaba iniciado al cierre de H2.

Entregado: work_policies/asignaciones append-only, employee_state con alta/backfill atómicos,
work_sessions/time_events inmutables, record_time_event y consulta operativa de estado.
Cinco transiciones legales, salida desde WORKING/PAUSED sin BREAK_END sintético, múltiples
sesiones, secuencia/versionado por empleado, política/zona fijadas por sesión y reloj efectivo
muestreado una sola vez tras el lock. Idempotencia persistente, auditoría y proyección atómicas.
Sin cierres automáticos; sesiones abiertas indican OPEN_SESSION sin inventar totales.

Continuación desde `a75f7c7fa7704f87d642d004884195e084918d68`, misma rama y PR:
- El 403 prematuro provenía de usar authorize/member_scope de H1, reservado a gestores.
  Migración aditiva con fichaje_clock y capability clock por tenant/empleado/principal/xid/backend.
  El EMPLOYEE válido sin política recibe ahora **400 POLICY_REQUIRED** sin escrituras parciales.
- Gates/capabilities y mutaciones H1 conservados. No se amplía el writer administrativo.
  Nuevo rol sin LOGIN/BYPASSRLS/herencia ni escritura de identidad; RLS/FORCE y grants mínimos.
  fichaje_state_reader solo consulta estado propio o autorizado a gestores.
- Orden: bind una vez → lock organización compartido con H1 → revalidación de acceso →
  lock employee_state → replay/máquina/reloj/escrituras. No repetir limpieza de contextos
  bajo el lock de organización. La primera revisión falló RACE-01; corregido y revalidado.
- Desactivar empleado o membresía impide fichajes y replay; el empleado inactivo con
  membresía activa conserva lectura autorizada de su estado.

Evidencia real del código `4819abb0c4122d5d76582bad4615753667dd6e1d`, 2026-09-22:
- [Database H1 + H2, run 35741052549](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35741052549): PASS.
  Ubuntu 24.04, Supabase CLI 2.117.0, stack local PostgreSQL 17/Auth/REST/Storage.
  `supabase db reset --local --no-seed` aplica las cuatro migraciones desde vacío.
  `supabase test db`: **180 pruebas SQL/pgTAP PASS** (106 H1, 43 motor H2, 31 capability H2).
  `python3 tests/integration/h2.py`: **102 checks H1 + 70 checks H2 PASS**,
  con login GoTrue real y JWT contra PostgREST/Storage, sin mocks de RLS.
  Contenedores destruidos al finalizar con `supabase stop --no-backup`.
- [CI general, run 35741052373](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35741052373): PASS.
  npm ci, typecheck, lint, **21 tests**, build, sintaxis shell y whitespace.
- El commit posterior únicamente registra esta evidencia. Ver Checks del PR para la
  ejecución automática adicional sobre ese commit documental; no modifica código probado.

Cobertura de salida H2:
| Criterio | Evidencia |
|---|---|
| STATE-01 | Las 12 celdas por RPC real: 5 legales y 7 rechazadas sin efectos; salida pausada preserva originales |
| TIME-01..05 | Hora cliente rechazada; muestra posterior al lock; medianoche y DST Madrid/Canarias en SQL; igualdad; regresión sin escrituras |
| IDEM-01..04 | 20 requests iguales, un evento/recibo/audit; payload distinto rechazado; timeout tras commit recupera recibo; revocado no puede replay |
| RACE-01..04 | 20 altas simultáneas, una proyección; 20 UUID distintos/misma versión: 1 éxito y 19 VERSION_CONFLICT; revocación gana lock; sin deadlocks |
| ATOM-01 | Fallo forzado de audit revierte evento, proyección, sesión y recibo; reintento tras rollback válido |
| IMM-01 | UPDATE/DELETE/TRUNCATE denegados a cliente y roles técnicos; triggers mantienen inmutabilidad aun con grants accidentales |
| Aislamiento | Cruces tenant/empleado/RPC/join/UUID denegados; GUC falsa no autoriza; clock no puede adquirir scope administrativo ni modificar identidad |

Límites: solo datos sintéticos y stack CI efímero. El entorno de edición no tiene Docker/PostgreSQL;
no se afirma ejecución DB local aquí. DST/igualdad usan fixtures SQL privilegiadas revertidas y
guard real, sin sustituir reloj/RPC. Timeout usa proxy local que pierde el ACK tras commit real.
Serialización conservadora por tenant, documentada. No H3, kiosco, informes H5, UI/PWA,
producción, datos reales ni configuración remota. Backup DB sigue bloqueado.

## OPS-02 — observabilidad y resiliencia (planificado)
Requisito aprobado por el usuario para ejecutar después de H6 y antes de H7. Queda incorporado al roadmap como puerta obligatoria de producción: telemetría segura, health checks, canaries sintéticos, invariantes read-only, alertas, retries idempotentes, rollback de release y reconstrucción limitada de proyecciones reconstruibles. Regla absoluta: ninguna automatización o IA modifica `time_events`, correcciones aprobadas ni historia laboral. OPS-02 está solo especificado; no implementado ni autorizado para ejecución todavía.

## Siguiente paso
Trabajo detenido tras el merge de PR #7. Esperar autorización expresa para HITO 4. OPS-02 se implementará después de H6 y antes de H7.

## HITO 3 — correcciones append-only
ESTADO: PASS — HITO 3 aprobado por el usuario y PR #7 integrado en `main`.
Rama `astra/hito-3-correcciones`; [PR #7](https://github.com/marioleongayo23-spec/fichaje/pull/7) integrado en `main`.
Base H2 y actualización documental OPS-02 conservada.

Entregado: correction_requests, correction_decisions y event_adjustments append-only;
RPC submit_correction/decide_correction y lectura del timeline efectivo. ADD/REPLACE/VOID,
cadenas por referencia/supersedes, motivo acotado, base_version y decisión única.
Originales inmutables; effective_at separado de server_at, ordinal explícito y corte histórico.
Replay completo valida transiciones, sesiones, orden, intervalos, solapamientos y tiempos futuros.
Aprobación reconstruye proyección e incrementa versión; rechazo no modifica timeline.
Auditoría, idempotencia persistente y cambios se confirman o revierten juntos.

Independencia: otro OWNER/ADMIN autorizado; solicitante y gestor afectado no pueden decidir.
Se comprueban vínculo actual, vínculo al solicitar y autor original para impedir bypass por
desvinculación. Sin excepción para empresas de un único gestor. Capacidad H3 aislada por
tenant/empleado/principal/transacción; RLS/FORCE, referencias compuestas y grants mínimos.
Locks compartidos con H1/H2 y permisos revalidados tras el lock. H1/H2 no reciben nuevas
capabilities; adaptación mínima del guard del reloj H2 conserva el máximo server_at original
aunque el timeline corregido retroceda o quede vacío. Se separa la secuencia original de la
proyección efectiva; el test TRUNCATE H2 incluye la nueva tabla referenciante, sin relajar el trigger.

Evidencia real del código `cbd207263fa61b4d26e1cfe745630d01a8287540`, 2026-09-23:
- [Database H1 + H2 + H3, run 35814742001](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35814742001): PASS.
  Supabase local efímero en CI, PostgreSQL real; `supabase db reset --local --no-seed`
  reconstruye desde vacío. **217 pruebas SQL/pgTAP PASS** (180 anteriores + 37 H3).
  **102 checks H1 + 70 H2 + 80 H3 PASS** con GoTrue/JWT/PostgREST/Storage reales.
  Contenedores destruidos con `supabase stop --no-backup`.
- [CI general, run 35814741994](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35814741994): PASS.
  Instalación, typecheck, lint, **21 tests**, build, sintaxis shell y whitespace.
- `npm run check`, `python3 -m py_compile tests/integration/h3.py`,
  `bash -n scripts/*.sh` y `git diff --check`: PASS en el entorno de edición.
  Sin Docker/PostgreSQL en este entorno; no se atribuye aquí la ejecución DB de CI.

| Criterio | Evidencia real |
|---|---|
| COR-01 | ADD/REPLACE/VOID válidos, cadenas sucesivas, rechazo sin ajustes, una decisión y replay idempotente |
| COR-02 | Solicitante/afectado/EMPLOYEE/gestor cruzado denegados; independencia tras desvincular; OWNER revisado por ADMIN independiente |
| COR-03 | Base obsoleta rechazada en aprobación/rechazo; 20 propuestas de una base dejan un ganador; carrera H2/H3 comparte versión |
| COR-04 | Replay imposible, intervalo negativo, solapamiento, futuro y empate sin ordinal válido rechazados sin efectos |
| COR-05 | Timeline/proyección/versión atómicos; fallo audit revierte decisión, ajustes, sesión, proyección y recibo; reintento válido |
| COR-06 | Originales idénticos antes/después; fuente/autor y server_at preservados; effective_at separado y lectura histórica |

Cobertura adicional: referencias a evento/sesión/ajuste de otro tenant denegadas, lectura
propia/gestor/anon y DML directo, grants técnicos negativos, 20 solicitudes y 20 decisiones
idénticas sin duplicados, revocación concurrente y bloqueo de replay con JWT revocado.
Fallos intermedios corregidos y revalidados: sintaxis SQL, fixture TRUNCATE con nueva FK,
mapeo HTTP de conflictos H3 y fixture PATCH con payload/filtro explícitos. Ningún test omitido
ni simulación de lógica SQL. El commit documental posterior registra esta evidencia; sus
Checks ejecutan de nuevo toda la suite sin cambiar el código probado.

Límites: datos exclusivamente sintéticos y stack CI efímero. Sin UI/PWA, kiosco H4, informes H5,
clasificaciones de horas, producción, datos reales ni configuración remota. Backup DB bloqueado.
PR #7 integrado por autorización expresa del usuario. H4 no iniciado. Trabajo detenido.
