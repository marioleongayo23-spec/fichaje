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
