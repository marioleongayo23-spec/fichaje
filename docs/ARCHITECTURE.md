# Arquitectura
## Componentes y fronteras
React + TypeScript + Vite: cliente no fiable. PWA instalable desde H6 (shell público únicamente).
Cloudflare Pages alojará únicamente estáticos; no se configura cuenta, dominio ni despliegue H0.
Supabase Auth identifica usuarios; PostgreSQL decide permisos, estados, tiempos y transacciones.
PostgREST expone lecturas RLS y RPC permitidas. Supabase Edge Function futura solo para gateway
kiosco/exportaciones: secretos aislados del bundle; no sustituye autorizaciones en PostgreSQL.
GitHub Actions valida cambios y permite backup manual de código, sin despliegues.

## Multiempresa
Un proyecto Supabase y esquema compartido para pilotos; no una base por cliente.
Todas las tablas de negocio llevan organization_id NOT NULL, índices empezando por tenant y
FK compuestas (organization_id, id). La selección del tenant en UI es solo una preferencia.
Membresía activa consultada en DB en cada petición; no confiar en user_metadata, rol enviado,
JWT antiguo con claim de rol ni en un filtro frontend. Recursos privados en schema private.
RLS habilitada y forzada; matriz en SECURITY. Ningún acceso de soporte global implícito.

## Transacción de fichaje (futuro H2)
1. Validar identidad; bloquear organización y membresía activas en modo compartido para
   serializar revocaciones. Administrar permisos usa bloqueo exclusivo en el mismo orden.
2. Resolver empleado dentro de tenant; bloquear fila employee_state FOR UPDATE (creada al alta).
3. Buscar clave idempotente con principal+tenant+operación; misma clave/digest devuelve
   respuesta previa solo tras revalidar permisos; digest distinto devuelve IDEMPOTENCY_CONFLICT.
4. Verificar expected_version. Otra clave con versión antigua: VERSION_CONFLICT sin evento.
5. Validar transición; obtener reloj servidor; insertar evento inmutable, auditoría, respuesta
   idempotente y actualizar proyección con versión incrementada, todo en una transacción.
6. Commit; ACK. Error revierte todas las escrituras. Bloqueos acotados (5 s), TIMEOUT reintentable
   con misma clave; máximo 3 reintentos con jitter. Nunca reintentar con clave nueva automáticamente.
Orden de bloqueos para todas las mutaciones: organización → membresías por UUID → empleado/estado
por UUID → petición. Evitar locks globales y deadlocks; ningún I/O externo durante transacción.

## Consistencia
READ COMMITTED + bloqueos explícitos y constraints para escrituras; serializar correcciones y fichajes
con el mismo estado. Recalcular proyección sobre todo el intervalo afectado antes de commit.
Exportaciones snapshot consistentes. Logs de éxito atómicos con acción; fallos de autenticación
se registran de forma independiente con límites de tamaño y sin datos secretos.
No Redis, colas ni microservicios para dos pilotos. Límite piloto objetivo: 2 empresas × 100 empleados;
probar p95 <1 s en 20 peticiones simultáneas, sin prometer SLA hasta medir.

## Observabilidad y autorrecuperación — OPS-02
Antes de H7 habrá una capa operativa separada del dominio: telemetría estructurada, métricas, health checks, canaries sintéticos, comprobadores de invariantes y control de salud de releases. Debe correlacionar por `request_id`, operación y SHA/release sin registrar payloads laborales, JWT, PIN, tokens ni secretos.

Canary: tenant/empleados exclusivamente sintéticos y aislados ejecutan periódicamente el flujo CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT y validan respuesta, RLS, auditoría e idempotencia. Nunca usar datos de clientes como sonda.

Invariantes read-only comprueban, entre otras, unicidad de sesión abierta, coherencia `employee_state` frente al timeline efectivo, secuencias, relación evento/audit/idempotencia y ausencia de referencias cross-tenant. Una desviación alerta y puede bloquear una ruta afectada; no autoriza a inventar ni modificar horas.

Self-healing permitido: retry con la misma clave idempotente y backoff, reinicio/redeploy de infraestructura, rollback de release degradada, reintento de jobs y reconstrucción de proyecciones declaradas reconstruibles desde fuentes inmutables. Self-healing prohibido: UPDATE/DELETE/REPLACE automático de `time_events`, decisiones/ajustes laborales o cualquier dato histórico con significado jurídico.

La promoción de release será CI → staging → pruebas sintéticas → canary → health gate → producción. H7 no puede aprobarse sin OPS-02 PASS y un fallo inducido en staging que demuestre detección, alerta y rollback seguro.

### Implementación OPS-02 (2026-09-26)
- Contrato único `ops/contract.json`: componentes, operaciones, resultados, clases de error, campos de
  evento, métricas y etiquetas (solo enumeraciones), alertas con severidad/ruta/runbook, umbrales y política
  de reintentos. Lo aplican `scripts/ops/opslib.py`, `supabase/functions/_shared/ops.ts`,
  `src/lib/telemetry.ts` y el vocabulario de `private.ops_telemetry_vocabulary`.
- Telemetría: una línea JSON por operación (scripts, gateway, firmador) y agregados del navegador enviados
  por la RPC de solo escritura `public.ops_ingest_client_metrics` (cubos de 5 min sin identidad ni
  release). Las métricas se derivan de eventos e informes (`metrics.py`, formato Prometheus); sin servicios
  nuevos.
- SEC-OPS-01: la telemetría del navegador es una señal no confiable (`trust: untrusted` en el contrato):
  solo dashboards, nunca alertas, gate, rollback ni reparaciones. El servidor impone vocabulario cerrado,
  ≤100 series distintas por llamada, 1..1000 eventos por serie, duración coherente con su cubo (+Inf ≤
  120 s) y cuotas persistentes por identidad y ventana de 5 min más límites globales por ventana
  (`private.ops_ingest_limits`, `ops_ingest_windows`, `ops_ingest_subjects`), con orden de bloqueo fijo
  (ventana nueva → identidad → ventana → métricas). La identidad es un seudónimo por ventana
  (`sha256(sal ‖ uid)`, sal aleatoria que se purga con su ventana); retención de 7 días de los cubos. La
  identidad de la release va solo en `<meta name="fichaje-release">` de `index.html` (gate RES-02).
- Salud: `/health/live` y `/health/ready` (cacheado 5 s, acotado a 2 s) en gateway y firmador; `health.py`
  agrega app, API, Auth, PostgreSQL (`private.ops_db_health()`), gateway y firmador en UP/DEGRADED/DOWN.
- Canary `canary.py`, invariantes `invariants.py`, reconstrucción `rebuild_projection.py`, jobs
  `jobs.py`, backups `backup_monitor.py`, alertas `alerts.py` (outbox: cada notificación sigue pendiente hasta
  que su ruta la acepta y se reintenta con el mismo `notification_id`; sink de prueba local; rutas reales en H7) y
  gate de release `release_gate.promote()` con `LocalDeployer` (releases inmutables en loopback).
- Base de datos (`20260926000100_ops_observability.sql`): roles de definidor `fichaje_ops`,
  `fichaje_ops_repair`, `fichaje_ops_ingest` y de entrada `fichaje_ops_monitor` (agregados),
  `fichaje_ops_reviewer` (detalle de un tenant, solo lectura) y `fichaje_ops_repairer` (reconstrucción
  autorizada); todos NOLOGIN, NOINHERIT y NOBYPASSRLS. Evidencia operativa append-only
  (`ops_invariant_runs/_findings`, `ops_original_baselines`, `ops_projection_repairs`).
- RES-03, proyecciones: la única proyección derivable es `private.employee_state`. Fuente de verdad:
  `time_events` + ajustes de decisiones APPROVE; `version` = nº de originales + nº de aprobaciones,
  `last_sequence` = máximo de secuencia, estado/sesión abierta/último evento = `private.validate_timeline`
  sobre el timeline efectivo. No es derivable tras una purga laboral H5 (marcas de agua conservadas):
  `PURGED`, nunca se rebajan versiones ni secuencias. Las demás tablas mutables (credenciales y buckets del
  kiosco, challenges, `export_jobs`, identidad) no son proyecciones y no se reconstruyen.

## Estado H0
Cliente Supabase lazy, validación de configuración y página de texto sin diseño. No tablas de negocio,
RPC, RLS, Auth real, worker PWA ni gateway operativos. Directorio supabase reservado para H1.
Referencias: [Claves públicas Supabase](https://supabase.com/docs/guides/getting-started/api-keys),
[RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security),
[funciones DB](https://supabase.com/docs/guides/database/functions),
[bloqueos PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

## H4 — frontera de kiosco implementada
Gateway Deno server-only en `supabase/functions/kiosk`; contrato y variables en
`supabase/README.md`. Validación de JWT vía Auth, Argon2id local y rol SQL dedicado
sin tablas/grants administrativos. Supabase Auth admin limitado a provisioning y
compensación de cuentas técnicas; nunca acceso universal a datos laborales.
No I/O externo bajo lock PostgreSQL: Auth/preflight/provisioning fuera de la transacción
final, que revalida permisos. Pepper en secret store servidor; CI solo valores aleatorios
efímeros. PIN de entrega cifrado para clave pública del gestor, no respuesta en claro.
Motor H2/H3 compartido por función invoker, autorizaciones separadas para Web y KIOSK.
No se despliega ni diseña UI, PWA, H5 u OPS-02 en este hito.

SEC-H4-01: la defensa de red recibe solo el peer TCP del runtime Deno, normalizado
y HMAC-SHA256 por tenant con `KIOSK_NETWORK_SECRET` independiente del pepper.
Cabeceras de red no se usan. Tras un proxy el peer es el proxy, sin inferir IP
original; metadata no confiable/no disponible deniega autenticación. Contrato,
limitaciones de despliegue y umbral adicional 60/15 min en SECURITY.md.

## H6 — cliente web y PWA
SPA sin framework adicional: sesión Supabase Auth, selector de tenant en memoria, RPC/lecturas RLS
H1-H5 sin cambios y confirmación solo tras ACK. Service worker de shell público, sin cola offline.
Gateway de kiosco y firmador de exportaciones por rutas del mismo origen (proxy inverso en despliegue,
decisión H7). El kiosco identifica con código+PIN y el servidor devuelve estado, versión y un
challenge por acción legal (KIO-H6-01, único cambio backend de H6). Ver `docs/UI_PWA.md`.

## H7 — despliegue de piloto (preparado; staging remoto pendiente)
```
navegador/kiosco ─HTTPS─▶ Cloudflare Pages: dist/ + _headers + /gateway/* (Pages Function, edge/gateway.ts)
                                   │ firma x-fichaje-edge (HMAC, 60 s)
                                   ▼
                  Supabase: Edge Functions kiosk/export-link · Auth · PostgREST · Storage privado · PostgreSQL 17
                                   │ dblink TLS verify-full
                                   ▼
                  PostgreSQL independiente del journal de recuperación
host de operación: health, canary, invariantes, alertas (PagerDuty/GitHub Issues), backup cifrado (age), restore
```
- **Mismo origen sin CORS**: la decisión pendiente de H6 se resuelve con una Pages Function en el mismo proyecto
  que sirve la app; las funciones solo aceptan peticiones firmadas por ella (contrato en `SECURITY.md` H7).
- **Despliegue**: `scripts/ops/deployers.py` (`PlatformDeployer`: wrangler desde la copia de la release y
  `supabase functions deploy --no-verify-jwt`), gobernado por `release_gate.promote()` con rollback a la
  última release sana; ninguna credencial de plataforma pasa por GitHub Actions. Procedimiento en `STAGING.md`.
- **Alertas reales**: `alerts.py` con adaptadores PagerDuty Events v2 (CRITICAL → página, `dedup_key` =
  huella) y GitHub Issues (WARNING → ticket), rutas por variables de entorno del host y sin PII.
- **Backup**: `scripts/backup_database.sh` (pg_dump 17 custom | age, verify-full, fallo cerrado) y
  `scripts/restore_database.sh` (restore aislado en una transacción); journal en instancia separada.
- **Carga**: la latencia del kiosco la domina Argon2id (19 MiB, t=2) serializado en cada instancia del gateway;
  el modelo de concurrencia real de Supabase Edge decide la cifra de staging.
