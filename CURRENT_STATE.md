# CURRENT_STATE — 2026-09-27
## Hito autorizado

### OPS-02 — observabilidad, canaries, invariantes, alertas y self-healing seguro

**ESTADO: implementado y en revisión en [PR #12](https://github.com/marioleongayo23-spec/fichaje/pull/12)
contra `main`, con la corrección SEC-OPS-01 de la auditoría independiente añadida al mismo PR, validada en
local y con CI completa en verde sobre `7113dde`. OPS-02 no está aprobado ni integrado en `main`. Sin merge.
H7 no autorizado.**
Rama `astra/ops-02-observabilidad-resiliencia` creada desde `main` `754c7f184fb14db151303c7ab7db72bb2629e7aa`
(la rama de trabajo `claude/ops-02-observabilidad-resiliencia-kzk0z9` contiene los mismos commits) y
sincronizada el 2026-09-27 con `main` `b64a16a6a21c965b0e01dce6ade7abd3296dca9e` (merge de PR #13, solo
documentación: cronología corregida de HITO 6, estado de OPS-02 y regla de merge explícito en `AGENTS.md`)
mediante un commit de merge, sin reescribir historia. La validación completa se repite sobre el commit
combinado y su evidencia se registra en PR #12.

Regla absoluta, verificada por la suite: ninguna automatización, script, agente o IA modifica
`time_events`, fichajes originales, decisiones o ajustes de corrección, horas efectivas ni historia
laboral; no hay cierre automático de jornadas ni fichajes inventados. El único dato derivado reescribible
es `private.employee_state`, solo desde fuentes inmutables, con referencia de autorización, idempotente,
auditado y BLOCKED si la fuente es incoherente.

#### SEC-OPS-01 — ingesta de telemetría del navegador (auditoría independiente, 2026-09-26)
**Causa.** `public.ops_ingest_client_metrics(p_release, p_batch)` solo validaba forma y vocabulario. Cualquier
identidad `authenticated` podía invocarla directamente, sin límite de llamadas, con hasta 100 series y 9.999
eventos por serie, y elegir `p_release`, creando combinaciones nuevas en `private.ops_client_metrics`. Los
límites de `src/lib/telemetry.ts` no eran una defensa. Impacto: métricas contaminables (tasas y latencias),
cardinalidad y crecimiento no acotados y posible degradación de la propia observabilidad.

**Solución** (en la migración de OPS-02 aún no integrada; sin cambios en H1-H6 ni en la UI):
- `release` deja de ser una dimensión de la ingesta: la RPC es `ops_ingest_client_metrics(p_batch)`, ni
  `ops_client_metrics` ni `ops_client_metrics_snapshot` tienen columna de release y el navegador ya no la envía.
  La identidad del artefacto que comprueba el gate RES-02 pasa a `<meta name="fichaje-release">` de
  `index.html`. Los eventos de servidor siguen llevando release y commit; la telemetría del navegador se
  relaciona con una release solo por tiempo (cubo de 5 min frente a promociones y rollbacks del gate).
- Validación en servidor: claves exactas, vocabulario cerrado, ≤100 series distintas por llamada, 1..1000
  eventos por serie y suma de duraciones dentro de los límites de sus cubos (+Inf ≤ 120 s). Un error responde
  `INVALID_INPUT` y no escribe nada.
- Rate limiting persistente en servidor por identidad y ventana fija de 5 min: 30 llamadas (también las
  rechazadas), 2.000 eventos y 200 series. Límites globales intencionados por ventana: 5.000 identidades,
  200.000 eventos y 1.000 filas por cubo. Están en `private.ops_ingest_limits` (una fila con CHECK acotados;
  solo el propietario de la base la ajusta; sin fila no se acepta nada). Un rechazo por cuota confirma el
  intento y responde 200 `{"accepted":0,"limited":true}`; el navegador descarta ese lote.
- Concurrencia: bloqueos de fila con orden fijo (ventana nueva → identidad → ventana → métricas).
- Sin PII: el emisor es `sha256(sal aleatoria de la ventana ‖ uid)`; no se guarda uid, email, membresía,
  empleado, nombre ni código. Solo se conservan la ventana actual y la anterior (sin actividad, hasta la
  siguiente llamada) y la sal se borra con su ventana. Nunca aparece en métricas, logs, alertas ni
  respuestas, ni es una dimensión. Los cubos del navegador se retienen 7 días (purga acotada).
- Señal no confiable: `trust: untrusted` en `ops/contract.json`. Ninguna alerta, gate, rollback, reintento ni
  reconstrucción la lee; las señales críticas salen de eventos de servidor, health, canary, invariantes y
  backups.
- Frontend: sin `p_release` y con duraciones acotadas a 120 s. `SECURITY`, `ARCHITECTURE`, `RUNBOOKS` y
  `ACCEPTANCE_TESTS` actualizados.

**Evidencia real** (local, 2026-09-26, tras reset desde vacío, mismo orden que CI; nada se ejecuta a través
del frontend salvo el E2E):
- `supabase test db`: **468 aserciones pgTAP PASS**. `ops_observability.test.sql` pasa de 69 a 116, con 48
  SEC-OPS-01: consecutivas cortadas en la cuota con los rechazados confirmados, `count=9999`, >1000, 101 series,
  duplicadas, duraciones fuera de su cubo, fuera de vocabulario, identificadores y release dentro del lote
  rechazados sin escritura; firma sin release; segunda identidad; cuotas de series y eventos; cubo lleno,
  volumen e identidades globales; fallo cerrado sin límites; expiración con reset, purga, sal distinta y
  retención; RLS forzada y ningún rol API/OPS con acceso a las tablas de cuota.
- `tests/integration/ops02.py`: **155 comprobaciones reales PASS** (139 + 16 SEC-OPS-01), con llamadas HTTP
  directas a PostgREST sin navegador: 40 llamadas consecutivas → exactamente 30 aceptadas y cuota persistente;
  segunda identidad no bloqueada; 13 cargas infladas/fuera de vocabulario/identificadoras, `count=9999`
  incluida, rechazadas sin escritura; anon rechazado; 20 releases aleatorias rechazadas sin columna ni fila;
  100 series acotadas; **2 identidades × 40 llamadas simultáneas → exactamente 30 aceptadas cada una, sin
  errores ni deadlocks**; reset y purga al expirar la ventana; límites globales intencionados; 1.000
  CLOCK_REGRESSION falsos solo en el dashboard, sin fuente de alerta; historia laboral, proyección,
  reparaciones, alertas, release (sin rollback), métricas de servidor y decisiones idénticas antes y después;
  seudónimos sin uid/email fuera de métricas y crecimiento acotado. El escáner final incluye uid, emails,
  contraseñas y seudónimos de las identidades atacantes: 0 hallazgos en logs, métricas, alertas e informes.
  El gate RES-02 (rollback real incluido) pasa con la nueva identidad del artefacto.
- `h5_render.py` (4) y `h5.py` **506 comprobaciones PASS** (H1 102 + H2 70 + H3 80 + H4 181 con KIO-H6-01 63 +
  H5 73), sin cambios.
- Playwright + Chromium tras reset desde vacío: **46/46 PASS** (el navegador solo envía `p_batch`;
  el almacén no tiene columna de release); `node scripts/scan_secrets.mjs dist test-results`: 0 hallazgos.
- `npm run check`: typecheck, lint, **111 tests unitarios**, build y escáner de `dist` PASS;
  `python3 -m unittest discover -s tests/ops` **52 PASS** (5 nuevos: la telemetría del navegador nunca cambia
  decisiones de alertas, ni la leen gate, reparaciones o jobs, e identidad del artefacto por `<meta>`); Deno
  `ops_test.ts` 5 y `network_test.ts` 2 PASS; `deno check` de kiosk y export-link, `bash -n scripts/*.sh`,
  `py_compile` y `git diff --check` PASS.

CI del PR sobre `7113ddeebb204c2dc5f4411ef429a60df3a14253` (SEC-OPS-01): PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017083),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017071) (468 pgTAP y 506
comprobaciones reales H1-H5 + KIO-H6-01),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017066) (46/46; escáner 0 hallazgos) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017088) (468 pgTAP y 155
comprobaciones reales, las 16 de SEC-OPS-01 incluidas). El commit posterior solo registra esta evidencia; sus
Checks repiten automáticamente toda la validación.

Riesgo residual: una identidad autenticada todavía puede sesgar agregados informativos dentro de su cuota
(por diseño no deciden nada). Las llamadas inválidas no escriben ni consumen cuota; limitar la inundación
HTTP en sí corresponde a la plataforma (H7). Con el sistema inactivo, los contadores seudónimos de la última
ventana persisten hasta la siguiente llamada.

Entregado:
- OBS-01: contrato `ops/contract.json`; eventos JSON por allowlist en scripts (`scripts/ops/opslib.py`),
  gateway del kiosco y firmador (`supabase/functions/_shared/ops.ts`) con release, commit y `request_id`;
  las excepciones se reducen a una clase estable (sin SQL, parámetros, cuerpos ni trazas).
- OBS-02: métricas en formato Prometheus derivadas de eventos e informes (`metrics.py`); telemetría del
  navegador agregada (`src/lib/telemetry.ts`) enviada por la RPC de solo escritura
  `public.ops_ingest_client_metrics` (cubos de 5 min sin identidad ni release, vocabulario cerrado, cuotas en
  servidor y señal no confiable: SEC-OPS-01).
- OBS-03: `/health/live` y `/health/ready` (cacheado 5 s, acotado a 2 s) en gateway y firmador; `health.py`
  agrega app, API, Auth, PostgreSQL (`private.ops_db_health()`), gateway y firmador en UP/DEGRADED/DOWN.
- OBS-04: `canary.py` web y kiosco sobre tenant sintético; si un ciclo quedó a medias rota a un empleado
  sintético nuevo y deja la sesión abierta como está.
- OBS-05: 21 invariantes read-only (`private.ops_invariant_*`, `invariants.py`) con evidencia append-only y
  líneas base de originales; el detalle solo se consulta por tenant.
- OBS-06: `alerts.py` con catálogo, severidad, runbook, CRITICAL→pager, WARNING→ticket, FIRING/RESOLVED,
  formato `fichaje.alert.v1` y sink de prueba local.
- OBS-07: roles `fichaje_ops*` NOLOGIN/NOINHERIT/NOBYPASSRLS; monitor (agregados), reviewer (un tenant, solo
  lectura) y repairer (solo reconstrucción); ningún OWNER/ADMIN/EMPLOYEE/anon alcanza funciones o tablas OPS.
- RES-01 `retry.py`/`jobs.py`; RES-02 `release_gate.py` (`promote()` + `LocalDeployer` de releases
  inmutables); RES-03 `rebuild_projection.py` (`--check` READ ONLY, `--apply` autorizado); RES-04
  `backup_monitor.py` y `.github/workflows/ops-monitor.yml` (diario, token de solo lectura).
- Runbooks (`docs/RUNBOOKS.md`, 12), inyección de fallos `faults.py` (solo loopback y
  `OPS_FAULT_INJECTION=1`), puerta `.github/workflows/ops02.yml`, `ci.yml` con los tests OPS-02 y
  `bash -n scripts/*.sh`, reglas nuevas en `scan_secrets.mjs`. Documentación: ARCHITECTURE (implementación y
  fuente de verdad de RES-03), SECURITY, RECOVERY y ACCEPTANCE_TESTS (asignación de evidencia OPS-02).

Evidencia local ejecutada el 2026-09-26 (Docker; Supabase CLI 2.117.0, PostgreSQL 17, GoTrue, PostgREST y
Storage locales, Deno 2.9.6, Node 24.19.0, Python 3.12), sobre el código previo a SEC-OPS-01 (`8e54371`; la
evidencia posterior está en la sección SEC-OPS-01):
- `supabase db reset --local --no-seed` + `journal_init.py` + `supabase test db`: **421 aserciones pgTAP
  PASS** (352 previas + 69 de `ops_observability.test.sql`).
- `python3 tests/integration/ops02.py` tras el mismo reset: **139 comprobaciones reales PASS**. Releases
  construidas desde el commit con el gateway y el firmador reales; tenants sintéticos. Fallos inducidos de
  verdad y detectados por el código operativo sin modificar: API 5xx, Auth rechazando, latencia, PostgreSQL
  rechazando, contenedor Auth detenido y PostgreSQL pausado (health, gateway, canary, alertas y
  resolución); ACK perdido tras commit y timeout de cliente (mismo payload y clave, una mutación, audit y
  recibo); error permanente, backoff acotado y circuito; POLICY_REQUIRED y CLOCK_REGRESSION del motor real;
  deriva de proyección, originales borrados y alterados, audit cross-tenant, ajuste de una decisión
  rechazada, guarda deshabilitada, sesión abierta antigua y exportación atrasada; reconstrucción exacta e
  idempotente con historia byte a byte igual y BLOCKED ante fuente alterada; jobs de exportación,
  retención y journal; release con defecto real en el gateway (lo detecta el canary de kiosco) y release
  sin asset (lo detecta health) con rollback automático; backups correcto, cercano al umbral, antiguo,
  fallido, ausente, sin artefacto, corrupto y sin checksums con PostgreSQL siempre `NOT_CONFIGURED`;
  escáner final sin secretos, PIN, emails, nombres, códigos, motivos ni identificadores de registro.
  Si falla, la suite solo imprime la etiqueta del check, el tipo o clase de error, ubicaciones de código
  y eventos por campos enumerados (mismo criterio que H4): nunca valores, SQL ni cuerpos HTTP.
- `python3 -m unittest discover -s tests/ops`: **47 tests PASS**; Deno `ops_test.ts`: **5 PASS**;
  `deno check` de kiosk y export-link PASS.
- `npm run check`: typecheck, lint, **109 tests unitarios**, build y escáner de `dist`: PASS.
  `bash -n scripts/*.sh`, `py_compile` y `git diff --check`: PASS.
- Playwright 1.56.1 + Chromium (escritorio y móvil) tras reset desde vacío, contra Auth/PostgREST/Storage/
  PostgreSQL, gateway y firmador reales: **46/46 PASS** (45 de H6 sin cambios + `telemetry.e2e.ts`: el
  navegador solo envía agregados acotados, sin tenant, persona, registro, request_id, email ni token).
  `node scripts/scan_secrets.mjs dist test-results`: 0 hallazgos.

- Regresión completa tras reset desde vacío: `h5_render.py` (4 tests) y `h5.py` **506 comprobaciones PASS**
  (H1 102 + H2 70 + H3 80 + H4 181 con KIO-H6-01 63 + H5 73), sin cambios respecto a H6.

CI del PR sobre `1e36d23` (código previo a la revisión automática): PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038022),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038009) (506 comprobaciones reales),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038062) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038021) (139 comprobaciones reales
con fallos inducidos en GitHub Actions).

CI del PR sobre el código final `8e54371377a45aa54faedaf2507dacc6f5426e0e` (tras la revisión automática): PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508387),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508381) (506 comprobaciones reales
H1-H5 + KIO-H6-01),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508379) (46/46; escáner 0 hallazgos) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508377) (421 pgTAP y 139
comprobaciones reales con fallos inducidos). El commit posterior solo registra esta evidencia; sus Checks
repiten automáticamente toda la validación.

Revisión automática del PR (Codex), 5 hilos verificados, respondidos y resueltos; corregidos con tests:
- Una alerta cuya entrega fallaba quedaba FIRING sin reintento: ahora hay outbox persistente y cada
  notificación se reintenta con el mismo `notification_id` hasta que su ruta la acepta (FIRING antes que
  RESOLVED); en producción el motor exige las rutas pager y ticket configuradas.
- Las líneas base de originales podían avanzar con una guarda append-only deshabilitada (hallazgo
  estructural sin tenant): cualquier hallazgo estructural CRITICAL congela todas las líneas base de la
  ejecución (`baselines_frozen`).
- Una purga reproducida tras restore (evidencia solo de tenant) marcaba a todo el tenant como purgado:
  ahora solo cuenta un empleado cuya historia tiene la forma de una purga legal (falta la secuencia 1, resto
  contiguo que empieza en CLOCK_IN) y un recibo huérfano solo es INFO si es anterior al corte de una purga
  laboral registrada. Sobre el dataset real de H1-H5 esto devuelve a comprobación completa a un empleado no
  purgado y hace aflorar `SEQUENCE_CONTIGUOUS` en el fixture histórico privilegiado de H5 (ya incoherente).
- Los jobs se modelan como mutaciones: solo se reintentan con idempotencia garantizada en servidor
  (exportación y journal); `purge_operational` añade un manifiesto por llamada y se ejecuta una sola vez.

Hallazgos corregidos durante la validación:
- `record_time_event` responde VERSION_CONFLICT con HTTP 500 (SQLSTATE 40001): la clasificación operativa lo
  trataba como UPSTREAM_5XX y lo reintentaba. Ahora el código estable manda sobre el estado HTTP, como en
  `src/lib/errors.ts`; el conflicto se intenta una sola vez.
- El probe de la aplicación aceptaba un asset ausente porque el host estático responde `index.html` con 200
  (fallback SPA, igual que Cloudflare Pages): ahora comprueba tipo y contenido.
- `kiosk_identification.test.sql` era intermitente bajo carga: un INSERT dependía de dos
  `clock_timestamp()` por defecto y saltaba el CHECK de 60 s antes del índice único. Solo cambia el test;
  las inserciones reales ya fijan `t` y `t+60 s`.

Límites: sin producción, staging, DNS, dominio, Cloudflare/Supabase remotos, secretos, claves age ni datos
reales. RES-02 se ha probado en un arnés CI aislado y efímero (`LocalDeployer`); su repetición en staging
sigue siendo puerta de H7. Rutas reales de alerta (pager/ticket), dashboards, retención de la evidencia OPS,
canary e invariantes programados contra producción y el adaptador de despliegue real
quedan para H7. `ops-monitor.yml` solo puede ejecutarse desde `main` (primera ejecución real tras el
merge). El backup PostgreSQL sigue bloqueado y se informa `NOT_CONFIGURED`, nunca en verde. La telemetría
del navegador es no confiable y tiene cuotas en servidor (SEC-OPS-01): no alimenta ninguna decisión.

### HITO 6 — UX/UI + PWA sobre H1-H5, con KIO-H6-01 resuelto

**ESTADO: PASS — HITO 6 aprobado técnicamente por autorización expresa del usuario el 2026-09-26, después
de una auditoría independiente posterior al merge.** Cronología (corrección documental del 2026-09-26):
1. [PR #10](https://github.com/marioleongayo23-spec/fichaje/pull/10) se integró en `main` el 2026-09-26
   (commit de merge `3c374358e1c17853c62cb29047642bee37a4efe5`, fechado a las 03:47 UTC) antes de la
   aprobación formal y sin autorización expresa de merge del usuario: el merge fue prematuro.
2. Después, HITO 6 se auditó de forma independiente; la revisión confirma que el contenido integrado supera
   la puerta técnica H6, por lo que el código no se revierte.
3. HITO 6 queda aprobado ahora por autorización expresa del usuario. La aprobación no fue anterior al merge.

Rama de origen `astra/hito-6-ux-pwa`. Merge: `3c374358e1c17853c62cb29047642bee37a4efe5`. Código probado:
`80a5ccd4874d53e79162169b0f675d998f1fb353`; commit final revisado:
`49d74ea6731d62e5d2374a8aba573fecfb36c28c` (solo documentación, Checks repetidos en verde).
CI en `main` sobre el merge `3c37435`: PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878110),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878128) (352 pgTAP;
506 comprobaciones reales, 63 de ellas KIO-H6-01),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878067) (45/45; 0 hallazgos del
escáner) y [Repository backup](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878111).
Esta sección solo registra evidencia ya ejecutada.

Evidencia de CI del código `80a5ccd`:
- [Database H1 + H2 + H3 + H4 + KIO-H6-01 + H5, run 36192804446](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36192804446): PASS.
  Supabase local efímero reconstruido desde vacío (`supabase db reset --local --no-seed`), Deno 2.9.6
  strict check de kiosk y export-link y tests Deno de red. **352 aserciones SQL/pgTAP PASS**
  (297 + 55 KIO-H6-01). **506 comprobaciones de integración real PASS: 102 H1 + 70 H2 + 80 H3 +
  181 H4 (incluidas 63 KIO-H6-01) + 73 H5**, con el gate KIO-07 de PIN, IP, digests y secretos de challenge.
- [Browser E2E, run 36192804457](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36192804457): PASS.
  **45/45 Playwright** (Chromium escritorio y móvil) contra Auth/PostgREST/Storage/PostgreSQL, gateway
  y firmador reales; `scan_secrets.mjs dist test-results`: 0 hallazgos.
- [CI general, run 36192804458](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36192804458): PASS
  (npm ci, typecheck, lint, 98 tests unitarios, build, escáner de secretos, shell y whitespace).
El commit posterior solo registra esta evidencia; sus Checks repiten automáticamente toda la validación.

**KIO-H6-01** (detectado al iniciar H6): `kiosk/authenticate` exigía `action` y `expected_version`
antes de validar código+PIN y ningún endpoint del kiosco devolvía estado ni versión, así que la UI no
podía ofrecer las acciones válidas. El usuario autorizó expresamente el 2026-09-25 resolverlo con un
contrato cerrado. Implementado en `supabase/migrations/20260925000100_kiosk_identification.sql` y
`supabase/functions/kiosk/index.ts`:
- `/authenticate` recibe solo código+PIN. Tras el PIN correcto el servidor resuelve empleado, estado
  OUT/WORKING/PAUSED y versión autoritativos y devuelve únicamente `state`, `version`, `actions` y un
  challenge por acción legal (OUT→CLOCK_IN; WORKING→BREAK_START+CLOCK_OUT; PAUSED→BREAK_END+CLOCK_OUT).
- Cada challenge queda ligado en servidor a organización, dispositivo, empleado, acción,
  `expected_version`, request_id propio, versión de credencial y TTL ≤ 60 s; no hay challenge genérico.
  Los hermanos comparten `grant_id`; ejecutar uno consume todos, y el segundo no crea evento.
- `/record` ya no acepta `employee_id` (lo determina el challenge). El gateway solo puede ejecutar
  `kiosk_admin_prepare/apply`, `kiosk_auth_begin`, `kiosk_auth_grant` y `kiosk_record`;
  `kiosk_auth_finish` se elimina y `kiosk_record_event` pasa a ser interno.
- Se mantienen Argon2id, pepper, límites 5/30/60, IP minimizada, errores genéricos, suelo de 300 ms,
  `no-store`, hashes de challenge, idempotencia, revocación, recuperación de ACK, máquina H2 y
  RLS/FORCE RLS. Scope `kiosk_grant` de solo lectura de la proyección del empleado verificado; el
  dispositivo sigue sin acceso libre a estado, eventos, directorio, historial ni RPC humanas.
- Fallo encontrado y corregido durante la validación: `kiosk_record` hacía dos limpiezas de contextos
  por transacción y el doble clic concurrente (12 peticiones) produjo `40P01`. Los scopes nuevos solo
  insertan la fila de su transacción (una única limpieza, como H1-H4); revalidado sin deadlocks.

**UI/PWA H6** (sin cambios de H1-H5 salvo KIO-H6-01): login, sesión, selector de organización,
empleado (fichar, «Mi registro», correcciones, exportación propia), OWNER/ADMIN (empleados, personas y
roles, horarios, bandeja de correcciones, clasificación, exportaciones con entrega controlada, kioscos y
PIN), kiosco `/kiosco` conectado al gateway real, PWA instalable con service worker de shell público
sin cola offline ni Background Sync. Decisiones y límites en `docs/UI_PWA.md`.

Evidencia local ejecutada el 2026-09-25 (entorno de edición con Docker; Supabase CLI 2.117.0,
PostgreSQL 17, GoTrue/PostgREST/Storage locales, Deno 2.9.6, Node 24.19.0, Python 3):
- `supabase db reset --local --no-seed` + `python3 tests/integration/journal_init.py` +
  `supabase test db`: **352 aserciones SQL/pgTAP PASS** (297 previas + 55
  `kiosk_identification.test.sql`), tres ejecuciones consecutivas.
- `python3 tests/integration/h5_render.py` PASS y `python3 tests/integration/h5.py` (cadena real
  completa): **PASS H1 102 + H2 70 + H3 80 + H4 181 + H5 73 = 506 comprobaciones**; H4 incluye las
  **63 comprobaciones KIO-H6-01** de `tests/integration/kio_h6.py` (tenant propio, gateway HTTP real)
  y el gate KIO-07 ampliado: PIN, IP y secretos de challenge ausentes de DB, logs de contenedores,
  gateway, salida y artefactos (los secretos de challenge solo existen en las respuestas HTTP).
- KIO-H6-01 cubierto en real: OUT/WORKING/PAUSED con solo acciones legales y versión correcta;
  challenges independientes; ejecutar uno invalida el hermano (secuencial y 8 peticiones
  concurrentes: una acción, un evento); caducado; reutilizado; otra acción, versión, request,
  empleado, dispositivo y tenant; PIN erróneo y código inexistente indistinguibles (≥ 300 ms);
  dispositivo revocado, empleado desactivado por RPC real y reset de credencial; límites de
  empleado y dispositivo; dispositivo sin tablas, RPC humanas ni rutas de consulta.
- Gateway: `deno check` estricto de kiosk y export-link y **2 tests Deno** de red PASS.
- `npm run check` (typecheck app+SW, lint sin avisos, **98 tests unitarios**, build, escáner de
  secretos de `dist`): PASS. `bash -n scripts/*.sh`, `py_compile` y `git diff --check`: PASS.
- Playwright 1.56.1 + Chromium, proyectos escritorio 1280×800 y móvil Pixel 5, tras
  `supabase db reset --local --no-seed` + `journal_init.py`, contra Auth/PostgREST/Storage/PostgreSQL
  locales, gateway Deno y firmador H5 reales: **45/45 PASS** (a11y, empleado, gestión, kiosco, PWA).
  Kiosco: empleado sin email ficha OUT→WORKING→PAUSED→OUT solo con las acciones ofrecidas por el
  servidor; confirmación solo tras el ACK (ACK retenido: solo «Enviando…»); ACK perdido tras commit y
  timeout antes del servidor → resultado desconocido y un único evento; doble toque; challenge
  reutilizado y caducado; dispositivo revocado; recibo limpio a 10 s y pantalla identificada en < 15 s
  (medido en la página); axe en todos los pasos; PIN, código, credencial, JWT del dispositivo y los 7
  secretos de challenge ausentes de almacenamiento, cachés, consola, logs y artefactos.
  `node scripts/scan_secrets.mjs dist test-results`: 0 hallazgos.
- Fallo intermedio corregido: la primera ejecución dio 44/45 porque la pantalla identificada se
  limpiaba a 15 s exactos más el renderizado (15,9 s medidos con sondeo de 1 s). El temporizador pasa
  a 14 s (estrictamente < 15 s) y la prueba mide dentro de la página con sondeo de 50 ms.

Límites: solo datos y secretos sintéticos efímeros; sin producción, despliegue ni datos reales. El
gateway y el firmador se sirven por proxy del mismo origen (`vite preview` en pruebas); el proxy
inverso de producción y su efecto en SEC-H4-01 quedan para H7. El listado de kioscos se deriva del
audit (sin nombre ni caducidad). Sin OPS-02 ni H7. OPS-02 permanece después de H6 y antes de H7.

HITO 0 Bootstrap aprobado por el usuario e integrado en `main` mediante PR #1 el 2026-09-21.
Rama de origen: `astra/hito-0-bootstrap`. Merge: `f9a02bb150b424d9cf0a47b741496c997b7bc085`.
HITO 1 aprobado por el usuario e integrado en `main` mediante PR #4 el 2026-09-22.
Rama de origen: `astra/hito-1-identidad-rls`. Merge: `ffd12c689824886abd8ba6f1e836057fc43ee9a8`.
HITO 2 aprobado por el usuario e integrado en `main` mediante PR #5 el 2026-09-22.
Rama de origen: `astra/hito-2-motor-horario`. Merge: `e4edd0d451627d6cd6e25aafc31819a77ee76116`.
HITO 3 aprobado por el usuario e integrado en `main` mediante PR #7 el 2026-09-23.
Rama de origen: `astra/hito-3-correcciones`. Merge: `a848c1c5adef50ada215d7362089db5da3ebf3f8`.
HITO 4 aprobado por el usuario, incluida SEC-H4-01, e integrado en `main` mediante PR #8 el 2026-09-23.
Rama de origen: `astra/hito-4-kiosco`. Merge: `76922f352a64f3bbf0d1d7ece2c7ae155f58d1a0`.

HITO 5 aprobado por el usuario e integrado en `main` mediante PR #9 el 2026-09-25.
Rama de origen: `astra/hito-5-informes-retencion`. Merge: `748186125194cf4819357d57a4d8567a8cdf3bab`.
HITO 6: PR #10 integrado en `main` el 2026-09-26 antes de la aprobación formal (merge prematuro, sin
autorización expresa); auditado después de forma independiente y aprobado técnicamente ahora por
autorización expresa del usuario, sin revertir el código.
Rama de origen: `astra/hito-6-ux-pwa`. Merge: `3c374358e1c17853c62cb29047642bee37a4efe5`.
Estado actual: HITO 6 aprobado y cerrado según la cronología corregida arriba. OPS-02 implementado en la
rama `astra/ops-02-observabilidad-resiliencia` mediante
[PR #12](https://github.com/marioleongayo23-spec/fichaje/pull/12), con SEC-OPS-01 corregido, y en revisión
técnica; todavía NO aprobado ni integrado en `main` (ver la sección OPS-02 al inicio). H7 sigue sin iniciar
y bloqueado hasta la aprobación de OPS-02.

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

## OPS-02 — observabilidad y resiliencia (especificación original)
Requisito aprobado por el usuario para ejecutar después de H6 y antes de H7. Queda incorporado al roadmap como puerta obligatoria de producción: telemetría segura, health checks, canaries sintéticos, invariantes read-only, alertas, retries idempotentes, rollback de release y reconstrucción limitada de proyecciones reconstruibles. Regla absoluta: ninguna automatización o IA modifica `time_events`, correcciones aprobadas ni historia laboral. Estado actual: OPS-02 implementado y en revisión técnica mediante PR #12 (rama `astra/ops-02-observabilidad-resiliencia`; ver la sección OPS-02 al inicio de este documento), con SEC-OPS-01 corregido; todavía NO aprobado ni integrado en `main`.

## Siguiente paso
HITO 6 aprobado y cerrado. OPS-02 (bloque obligatorio después de H6 y antes de H7) está implementado, con SEC-OPS-01 corregido, y en revisión técnica mediante PR #12, sin aprobar ni integrar en `main`: queda pendiente la auditoría independiente de PR #12 sobre el commit sincronizado con `main`, y el merge requiere una orden explícita y posterior del usuario. H7 sigue sin iniciar y bloqueado hasta que OPS-02 esté aprobado e integrado y el usuario lo autorice.

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
PR #7 integrado por autorización expresa del usuario. H4 autorizado posteriormente; ver sección siguiente.



## HITO 4 — kiosco seguro
ESTADO: PASS — HITO 4 aprobado por el usuario, incluida SEC-H4-01, y PR #8 integrado en `main`.
Rama `astra/hito-4-kiosco`, base main `4d2a40d09be431fd1f8cafe1365c7b71b8b520bf`.
[PR #8](https://github.com/marioleongayo23-spec/fichaje/pull/8), integrado en `main`.

Entregado: cuatro tablas privadas FORCE RLS, identidades Auth técnicas con exclusión
bidireccional de memberships, provisioning/revocación OWNER/ADMIN y reset auditado.
Gateway Deno server-only valida JWT con GoTrue; SQL por login dedicado con únicamente
el rol gateway (EXECUTE de entrypoints, sin tablas ni service_role). Auth admin solo
para crear/compensar cuentas técnicas; no acceso universal a datos laborales.
PIN CSPRNG de ocho dígitos, Argon2id 19 MiB/t=2/p=1, salt individual de 16 bytes y
pepper externo de >=32 bytes. Entrega cifrada RSA-OAEP-256 al gestor; ningún PIN en claro
en respuestas, DB o logs. Reset conserva locks y revoca credencial/challenges anteriores.
Rate limit persistente por empleado y dispositivo, 5/30 fallos en 15 minutos, sin bypass
con PIN correcto y conservado tras reiniciar gateway. Errores externos genéricos y no-store.
Challenge de 256 bits, solo hash, TTL 60 s, ligado a tenant/empleado/dispositivo/acción/
versión/request_id. Consumo, evento, estado, audit KIOSK e idempotencia en una transacción.
Recuperación exacta tras perder ACK, sin nuevo fichaje, incluso tras caducar el challenge
consumido; siempre revalida dispositivo, empleado y versión de credencial.

H2/H3 comparten una única función invoker `private.apply_time_event`: misma máquina,
locks, política, reloj/high-water de originales, secuencia e inmutabilidad. Autorización
humana original conservada; kiosk tiene capabilities y RLS separadas. Sin acceso a
directorio, correcciones administrativas, memberships, roles o exports.

Evidencia real del código `b3fa80ed3c68fb9eda6ba24efaaf5ad43d934da8`, 2026-09-23:
- [Database H1 + H2 + H3 + H4, run 35839508363](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35839508363): PASS.
  Ubuntu 24.04, Deno 2.9.6, Supabase CLI 2.117.0, PostgreSQL 17, GoTrue/PostgREST/Storage
  reales. `supabase db reset --local --no-seed` reconstruye las seis migraciones desde vacío.
  **246 tests SQL/pgTAP PASS** (217 previos + 29 H4).
  **346 checks de integración PASS: 102 H1 + 70 H2 + 80 H3 + 94 H4**.
  Gateway HTTP real, sin mocks de RLS/Auth. Concurrencia, revocación con JWT previo y
  lock primero, 12 consumos simultáneos/un evento, payload distinto, ACK perdido por
  proxy tras commit real, rollback audit, matriz H2 completa por kiosco e inmutabilidad.
  Prueba KIO-07 escanea PIN sintéticos conocidos en memoria contra tablas serializadas,
  logs de contenedores/gateway/suite, respuestas HTTP y artefactos temporales generados:
  ninguna fuga en claro. Los buffers se imprimen solo después del gate.
  Stack destruido con `supabase stop --no-backup` al terminar.
- [CI general, run 35839508364](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35839508364): PASS.
  npm ci, typecheck, lint, **21 tests**, build, shell y whitespace.
- Entorno de edición: `npm run check`, Deno strict check, Python compile y diff check PASS.
  No Docker/PostgreSQL local: la ejecución DB/Auth atribuida aquí es la de CI.
- Fallos intermedios corregidos: sonda de arranque demasiado corta para suelo de 300 ms;
  INHERIT de la membresía del login efímero PostgreSQL; doble serialización JSONB del
  driver. Provisioning concurrente compensa la cuenta Auth que no ganó. Ningún test omitido.
- El commit posterior solo registra esta evidencia. Sus Checks repiten automáticamente
  la suite; no cambia el código probado.

Límites: solo datos/secretos sintéticos efímeros. Gateway probado como módulo Deno por HTTP
con stack Supabase real local de CI; no despliegue Edge remoto ni producción. Entrega de
PIN es un contrato cifrado backend; interfaz y limpieza visual a 15 s corresponden a H6.
No fichaje offline, ACK optimista, informes/retención H5, UI/PWA H6, OPS-02 ni datos reales.
OPS-02 permanece después de H6 y antes de H7. Compensación de Auth en fallo de red es
best effort; identidades no vinculadas no obtienen acceso tenant y deben reconciliarse
antes del piloto. Backup DB sigue bloqueado. HITO 4 cerrado; H5 no iniciado.

## Revisión SEC-H4-01 (aprobada e integrada)
En la misma rama astra/hito-4-kiosco y PR #8. Defensa adicional por peer TCP
normalizado y HMAC tenant con secreto backend independiente; bucket persistente
60/15 min, sin cambios H1/H2/H3 ni límites empleado/dispositivo. Frontera de
confianza y proxy documentadas. KIO-07 ampliado para IP y digests.
Estado de esta revisión: **PASS; HITO 4 y SEC-H4-01 aprobados e integrados en main**.
Evidencia del código `a820a417d03b543ebb8ff7470cffc0ee3e07c755`:
- [Database run 35869927438](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35869927438): PASS, Supabase/PostgreSQL/Auth reales, reset desde vacío sin seed; **251 SQL/pgTAP**, **356 checks integración (102 H1 + 70 H2 + 80 H3 + 104 H4)**. Gateway strict typecheck y **2 tests Deno** PASS. Ninguna suite omitida.
- [CI run 35869927465](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35869927465): PASS; npm ci, typecheck, lint, **21 tests**, build, shell y whitespace.
- SEC-H4-01: 60 fallos reales desde un peer TCP sintético repartidos entre tres dispositivos, headers falsificados sin alterar el bucket, bloqueo persistente tras reinicio y frente a PIN correcto, separación por peer/tenant, expiración servidor, RLS y contadores previos conservados.
- KIO-07: PIN/IP sintéticos ausentes de DB/logs/respuestas/artefactos; todos los digests de red ausentes de logs/respuestas/artefactos/audit laboral. Solo HMAC en tabla privada. Captura y escaneo en memoria antes de imprimir resultados.
- Verificación local: npm run check, Deno check/test, Python compile, shell y whitespace PASS. DB/Auth se ejecutaron en CI, no se simularon localmente.
Este commit documental registra la evidencia anterior y no cambia código probado.
PR #8 integrado por autorización expresa del usuario. Sin iniciar H5 ni OPS-02; sin producción, secretos reales ni datos reales. OPS-02 permanece después de H6 y antes de H7. Trabajo detenido.

## HITO 5 — aprobado e integrado
ESTADO: PASS. HITO 5 aprobado por el usuario e integrado en `main` mediante PR #9.

Entregado: snapshot materializado consistente; exportación privada determinista CSV/JSON/PDF;
clasificaciones append-only; entrega controlada con recibo; purga laboral y operativa mediante
proceso offline mínimo; holds append-only; manifiestos transaccionales; journal PostgreSQL separado
de bajas, holds, liberaciones y purgas; y replay idempotente después de restore.

Evidencia final del código `4ee30b5f43828d7076eba9252f9779c58c392c89`, 2026-09-25:
- [Database H1 + H2 + H3 + H4 + H5, run 36149687175](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36149687175): PASS.
  Supabase local efímero reconstruido desde vacío, PostgreSQL 17, Auth, PostgREST y Storage reales.
  **297 aserciones SQL/pgTAP PASS**, **4 tests de generación CSV/JSON/PDF/DST PASS** y
  **429 checks de integración PASS: 356 H1-H4 + 73 H5**. Sin tests omitidos.
- H5 prueba transacciones PostgreSQL concurrentes: una corrección aprobada durante la generación
  conserva un paquete íntegramente anterior al cutoff, nunca híbrido. Prueba Auth y RLS de empleado,
  OWNER/ADMIN, kiosco y cross-tenant; Storage privado, URL firmada y expirada, revocación y TTL.
- Purga laboral real leaf-first sin CASCADE, plazo exacto y ampliación por correcciones, sesiones
  incompletas bloqueadas, receipts conservados, holds de organización/empleado, counts/digest y
  rollback completo ante fallos forzados de audit, manifest, Storage y journal.
- Restore sintético real: `pg_dump`, cambios posteriores, `pg_restore` sobre PostgreSQL y replay del
  journal externo. Verifica bajas, holds/liberaciones, tombstones, RLS, idempotencia y otro tenant intacto.
- [CI general, run 36149687094](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36149687094): PASS.
  Typecheck, lint, **21 tests**, build, shell y whitespace.
- Verificación local final: `npm run check`, Python compile, shell y `git diff --check` PASS.

Todo usa datos y credenciales exclusivamente sintéticos y efímeros. No hay producción, backup DB real,
datos/secretos reales, UI/PWA, H6 ni OPS-02. OPS-02 permanece después de H6 y antes de H7.
