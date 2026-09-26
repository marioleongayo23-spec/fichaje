# Runbooks operativos — OPS-02

Procedimientos mínimos para las alertas de `ops/contract.json` (catálogo, severidad, ruta y enlace de
runbook). Revisado el 2026-09-26. Son decisiones técnicas de operación, no requisitos legales.

## Reglas comunes a todos los runbooks
- **Nunca** se modifica historia laboral para cerrar una alerta: `time_events`, sesiones, solicitudes,
  decisiones y ajustes de corrección, horas efectivas, `server_at`, `effective_at` ni evidencias. Tampoco
  se crean BREAK_END/CLOCK_OUT artificiales, se cierran sesiones abiertas ni se borran errores históricos.
  Una incidencia de jornada se resuelve solo con el flujo H3 (solicitud + decisión independiente).
- **Self-healing permitido**, siempre acotado, observable y repetible: reintento idempotente con la misma
  clave (`scripts/ops/retry.py`), reinicio de un componente, redeploy o rollback a una release previamente
  sana (`scripts/ops/release_gate.py`), reintento de job con idempotencia garantizada en servidor
  (`scripts/ops/jobs.py`: exportación y journal; la purga operativa se ejecuta una vez) y reconstrucción
  de `private.employee_state` (única proyección autorizada) con `scripts/ops/rebuild_projection.py`.
- IA/automatización: puede diagnosticar, resumir, citar checks fallidos y logs saneados, proponer runbook,
  issue o PR revisable. No recibe credenciales de producción, datos laborales completos ni SQL mutante.
- Evidencia mínima a preservar siempre: notificación de alerta (JSON `fichaje.alert.v1`), eventos OBS-01
  del intervalo, informe de health/canary/invariantes/backup, release y commit afectados. Nunca volcados de
  datos, JWT, PIN, challenges, contraseñas, emails, nombres, códigos de empleado ni motivos.
- Escalado: CRITICAL → ruta `pager` (guardia técnica); WARNING → ruta `ticket`. Toda deriva de invariantes
  crítica o sospecha de manipulación escala además al responsable del tratamiento de la empresa afectada
  (RGPD) según `docs/SECURITY.md`.

Comandos (entorno de operación con login técnico que solo hereda el rol de entrada indicado):
`health.py` (monitor), `canary.py run`, `invariants.py summary|record` (`fichaje_ops_monitor`),
`invariants.py findings --org` y `rebuild_projection.py --check` (`fichaje_ops_reviewer`),
`rebuild_projection.py --apply` (`fichaje_ops_repairer`, requiere `--authorization-ref`),
`backup_monitor.py`, `jobs.py`, `metrics.py`, `alerts.py` (todos en `scripts/ops/`); el gate de release es
`release_gate.promote()`, invocado por el pipeline de despliegue.

<a id="api-down"></a>
## API down (PostgREST o aplicación web) — `API_DOWN`, `APP_DOWN`, `ERROR_RATE_HIGH`, `LATENCY_HIGH`, `SLOW_OPERATIONS`, `RETRY_REPEATED`
- **Detección**: `health.py` → `api` DOWN (la sonda anónima ya no obtiene el 401/42501 esperado: 5xx,
  timeout o respuesta inesperada) o `app` DOWN (índice o assets del build no servidos). Tasa de error,
  p95 o reintentos por encima de `thresholds`.
- **Impacto**: no se puede fichar por web ni consultar; el kiosco sigue si su gateway y PostgreSQL están UP.
- **Automático permitido**: reintento idempotente de sondas; redeploy/rollback de la última release sana si
  coincide con un despliegue (`release_gate.promote()` lo hace dentro del gate de despliegue).
- **Prohibido**: reintentar mutaciones con un `request_id` nuevo; desactivar RLS o exponer esquemas.
- **Escalar**: CRITICAL > 5 min o si Supabase/Cloudflare reportan incidente.
- **Evidencia**: informe de health, eventos de `probe.api`/`probe.app`, release/commit.
- **Recuperación**: dos ciclos de health UP y canary PASS; alerta RESOLVED.

<a id="auth-down"></a>
## Auth down — `AUTH_DOWN`
- **Detección**: `/auth/v1/health` sin 200 o timeout; gateway `/health/ready` con `auth` DOWN.
- **Impacto**: sin login humano ni validación de JWT del kiosco (el gateway deniega: falla cerrado).
- **Automático permitido**: reintentos de sonda; reinicio del contenedor/servicio Auth donde exista control.
- **Prohibido**: aceptar tokens sin verificar, cachear sesiones o "modo degradado" que fiche sin Auth.
- **Escalar**: inmediato (pager); proveedor si es gestionado.
- **Evidencia**: eventos `probe.auth`, respuestas agregadas del gateway (`UNAUTHENTICATED`).
- **Recuperación**: Auth UP, canary web y kiosco PASS.

<a id="postgres-down"></a>
## PostgreSQL down o saturado — `POSTGRES_DOWN`, `DB_SATURATION`
- **Detección**: login monitor no conecta o `private.ops_db_health()` excede el timeout; ratio de
  conexiones ≥ 0,8 o esperas de lock ≥ umbral; eventos `RETRYABLE_TIMEOUT` (55P03/57014).
- **Impacto**: sin fichajes ni correcciones; el gateway responde `RETRYABLE_TIMEOUT` sin ACK optimista.
- **Automático permitido**: reintento idempotente con la misma clave; reinicio del servicio gestionado.
- **Prohibido**: matar transacciones de fichaje en curso para "desbloquear", `TRUNCATE`, restaurar backup
  sin el procedimiento de `docs/RECOVERY.md`.
- **Escalar**: inmediato; si hay pérdida de datos, abrir incidente de recuperación (H7).
- **Evidencia**: salida de `ops_db_health`, eventos con `DB_UNAVAILABLE`/`RETRYABLE_TIMEOUT`, deadlocks.
- **Recuperación**: health UP, invariantes sin nuevas CRITICAL, canary PASS.

<a id="kiosk-gateway-down"></a>
## Gateway del kiosco caído — `KIOSK_GATEWAY_DOWN`
- **Detección**: `/health/live` o `/health/ready` del gateway sin 200 / estado DOWN; canary kiosco FAIL.
- **Impacto**: empleados sin email no pueden fichar; contingencia de la empresa + corrección posterior.
- **Automático permitido**: reinicio del proceso/función; rollback de la release si coincide con despliegue.
- **Prohibido**: ampliar grants del login SQL del gateway, desactivar límites 5/30/60, loguear cuerpos.
- **Escalar**: inmediato (pager).
- **Evidencia**: eventos `kiosk-gateway` (fase y clase estable, nunca PIN/challenge/IP), release/commit.
- **Recuperación**: ready UP y canary kiosco PASS con el mismo contrato KIO-H6-01.

<a id="export-worker-failure"></a>
## Fallo del worker de exportación o del firmador — `JOB_FAILED{job=export}`, `EXPORT_BACKLOG`, `EXPORT_LINK_DOWN`
- **Detección**: `jobs.py export` falla (Storage, verificación, caducidad); invariante `EXPORT_JOB_STATE`
  (PENDING > 1 h o caducado > 48 h); firmador `/health/ready` DOWN.
- **Impacto**: exportaciones no disponibles; ningún READY sin objeto verificado (H5).
- **Automático permitido**: reintento del job con clave de servidor (`PENDING→READY` una sola vez por `job_id`,
  objeto con ruta fija y upsert).
- **Prohibido**: marcar READY a mano, regenerar el snapshot con otro corte, enlaces públicos permanentes.
- **Escalar**: ticket; pager si la entrega es a Inspección o representantes con plazo.
- **Evidencia**: eventos `job.export`, clase de error, número de intentos.
- **Recuperación**: job en éxito, backlog vacío, firmador UP.

<a id="retention-worker-failure"></a>
## Fallo del worker de retención — `JOB_FAILED{job=retention}`, `RETENTION_OVERDUE`
- **Detección**: `jobs.py retention` falla (`LEGAL_HOLD`, Storage) o invariante `RETENTION_OVERDUE`.
- **Impacto**: datos operativos caducados (challenges, buckets, exportaciones) retenidos más de lo previsto.
- **Automático permitido**: ninguno dentro de la misma ejecución: `purge_operational` no tiene clave de
  idempotencia en servidor (cada llamada añade un manifiesto `retention_runs`), así que se ejecuta una vez;
  la siguiente ejecución programada o el operador la repite tras revisar la causa.
- **Prohibido**: purga laboral automática, saltar holds, borrar evidencia fuera de `purge_labour`.
- **Escalar**: ticket; DPO si el retraso supera la política de `docs/COMPLIANCE.md`.
- **Evidencia**: manifiesto `retention_runs`, eventos `job.retention`.
- **Recuperación**: job en éxito e invariante sin hallazgos.

<a id="backup-stale-failure"></a>
## Backup antiguo, fallido, ausente o no verificable — `BACKUP_*`, `DB_BACKUP_NOT_CONFIGURED`
- **Detección**: `backup_monitor.py` (workflow `backup.yml`: último run, conclusión, artefacto presente,
  `SHA256SUMS`, `git bundle verify` y restauración de ensayo del bundle, frescura ≤ 26 h). La base de datos
  informa `NOT_CONFIGURED` mientras el backup PostgreSQL siga bloqueado: nunca verde.
- **Impacto**: RPO comprometido. Un upload correcto no demuestra un restore válido.
- **Automático permitido**: relanzar el workflow de backup de repositorio (`workflow_dispatch`).
- **Prohibido**: activar `backup_database.sh` sin el cambio aprobado de H7; subir dumps a artefactos.
- **Escalar**: CRITICAL inmediato; `DB_BACKUP_NOT_CONFIGURED` es CRITICAL en producción.
- **Evidencia**: informe del monitor (run id, conclusión, edad, verificación), sin contenido del backup.
- **Recuperación**: estado `OK` verificado; para base de datos, solo tras el ensayo cifrado de H7.

<a id="canary-failure"></a>
## Canary sintético roto — `CANARY_FAILED`
- **Detección**: `canary.py run` falla un paso (respuesta, estado, versión, `server_at`, RLS, audit o
  idempotencia) en el canal web o kiosco.
- **Impacto**: probable fallo real de fichaje para usuarios.
- **Automático permitido**: repetir el ciclo; si el empleado sintético quedó a mitad de ciclo se rota a un
  empleado sintético nuevo (nunca se cierra su sesión); rollback si coincide con una release.
- **Prohibido**: usar empleados reales como sonda, borrar historia sintética, desactivar validaciones.
- **Escalar**: CRITICAL; si solo falla tras un despliegue, `release-degraded`.
- **Evidencia**: informe del canary (paso, clase de error, request_id sintético), release/commit.
- **Recuperación**: ciclo completo PASS en ambos canales.

<a id="invariant-drift"></a>
## Deriva de invariantes — `INVARIANT_CRITICAL`, `INVARIANT_WARNING`
- **Detección**: `invariants.py summary` (solo recuentos) y `record` (evidencia append-only + líneas base
  de originales). Detalle por tenant solo para revisión humana: `invariants.py findings --org`.
- **Impacto**: según invariante; toda deriva bloquea la autorreparación que no esté expresamente autorizada.
- **Automático permitido**: ninguno sobre historia. `PROJECTION_DRIFT` con `repairable=true` admite
  `rebuild_projection.py --check` y, con referencia de autorización, `--apply` (solo `employee_state`,
  idempotente, auditado; queda `BLOCKED` si la fuente inmutable es incoherente).
- **Prohibido**: "corregir datos incoherentes", reescribir originales o ajustes para que la invariante pase,
  rebajar versiones o secuencias, cerrar sesiones abiertas (`OPEN_SESSION_STALE` se resuelve con H3).
- **Escalar**: `ORIGINAL_IMMUTABLE`, `TENANT_REFERENCE`, `SEQUENCE_CONTIGUOUS`, `AUDIT_WITHOUT_EVENT`,
  `RECEIPT_WITHOUT_EVENT` o guardas deshabilitadas → incidente de seguridad (posible acceso privilegiado).
- **Evidencia**: run y findings de `private.ops_invariant_runs/_findings`, líneas base, evidencia de repair.
- **Recuperación**: nuevo run sin la invariante; la historia sigue byte a byte igual.

<a id="clock-regression"></a>
## CLOCK_REGRESSION y VERSION_CONFLICT anómalo — `CLOCK_REGRESSION`, `VERSION_CONFLICT_HIGH`
- **Detección**: eventos/telemetría con `CLOCK_REGRESSION` (reloj del servidor por detrás de la marca de
  agua de originales) o proporción de `VERSION_CONFLICT` sobre fichajes ≥ umbral.
- **Impacto**: fichajes rechazados sin escritura (correcto); usuarios deben reintentar.
- **Automático permitido**: ninguno sobre datos; revisar NTP/servicio de tiempo del proveedor.
- **Prohibido**: aceptar hora del cliente, adelantar/atrasar `server_at`, relajar `check_clock`.
- **Escalar**: proveedor de infraestructura si persiste; VERSION_CONFLICT alto → revisar UI/doble dispositivo.
- **Evidencia**: recuentos agregados por componente, release/commit.
- **Recuperación**: sin nuevas regresiones en dos ventanas; tasa de conflictos normal.

<a id="release-degraded"></a>
## Release degradada — `RELEASE_DEGRADED`, `RELEASE_DEGRADED_NO_ROLLBACK`
- **Detección**: `release_gate.promote()` (health → pruebas sintéticas → canary → gate) en rojo. En OPS-02 se
  ejerce con `LocalDeployer` en la puerta CI; H7 solo sustituye el adaptador de despliegue (Pages/Edge).
- **Impacto**: la promoción se detiene; sin rollback exitoso, usuarios afectados (CRITICAL).
- **Automático permitido**: detener promoción, redeploy de la release previamente sana y repetir health +
  canary. Migraciones de base de datos solo compatibles hacia atrás (expand/contract); el rollback es de código.
- **Prohibido**: rollback de datos, reparar historia para que el canary pase, desplegar sin gate.
- **Escalar**: `RELEASE_DEGRADED_NO_ROLLBACK` inmediato (pager).
- **Evidencia**: informes del gate de la candidata y de la release restaurada, commit, alertas.
- **Recuperación**: release anterior activa con health UP y canary PASS; RESOLVED emitido.

<a id="recovery-journal-unresolved"></a>
## Recovery journal sin resolver — `RECOVERY_JOURNAL_BLOCKED`, `JOB_FAILED{job=recovery_journal}`
- **Detección**: `jobs.py journal-check` — entradas PREPARED sin finalizar más de 10 min, transacción en
  curso, fuente incoherente, o invariante `JOURNAL_OUTBOX`.
- **Impacto**: la recuperación tras restore queda bloqueada (H5): no se reabre el servicio.
- **Automático permitido**: `jobs.py journal-reconcile` contra la instancia original viva (añade
  COMMITTED/ABORTED según `pg_xact_status`, sin editar entradas).
- **Prohibido**: presumir commit o rollback, borrar/editar entradas, reconciliar desde una base restaurada.
- **Escalar**: CRITICAL; reconciliación offline autorizada si se perdió la instancia.
- **Evidencia**: recuentos del journal, ids técnicos de entrada, estado de `pg_xact_status`.
- **Recuperación**: cero entradas sin finalizar y outbox coherente.
