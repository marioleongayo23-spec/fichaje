# Criterios de aceptación
## H0 ejecutables
`npm ci` y `npm run check`: typecheck, ESLint con cero warnings, Vitest y build Vite.
Tests de configuración: ausente, incompleta, URL inválida, HTTPS, clave privada rechazada y
cliente válido sin red ni persistencia de sesión. Render bootstrap sin variables.
Tests backup en repositorio temporal con dos commits, otra rama y tag: bundle --all verificado,
clonado y comparación refs; snapshot exacto del HEAD, sin untracked; checksums válidos.
Rechazar shallow y árbol sucio; fallo seguro si se solicita upload sin configuración; script DB
no invoca pg_dump aunque se le proporcionen variables. Sintaxis shell y git diff --check.
Workflows: permisos contents:read, CI sin Secrets, backup manual fetch-depth:0 y no DB.
No dar PASS a seguridad multiempresa o lógica SQL en H0: aún no implementadas.

## Casos obligatorios futuros (DB real, no mocks del predicado)
| IDs / hito | Prueba y resultado exigido |
|---|---|
| TEN-01..06 / H1 | Dos tenants con los tres roles: SELECT/RPC/UUID cruzado/FK/join/Storage denegados; anon sin acceso |
| ROLE-01..04 / H1 | EMPLOYEE no eleva rol; ADMIN no gestiona OWNER; no borrar último OWNER; revocación con JWT anterior efectiva |
| STATE-01 / H2 | 3 estados × 4 acciones; cinco transiciones legales, siete rechazadas; salida desde pausa contabiliza bien |
| TIME-01..05 / H2 | Cliente falsifica hora; medianoche; DST Madrid/Canarias; iguales instantes; regresión reloj rechazada |
| IDEM-01..04 / H2 | Mismo request simultáneo crea un evento/recibo; payload distinto conflicto; timeout tras commit devuelve mismo ID; revocado no recupera recibo |
| RACE-01..04 / H2 | 20 requests distintos misma expected_version: uno gana; alta simultánea sin doble estado; revocación concurrente; sin deadlock persistente |
| ATOM-01 / H2 | Fallar inserción audit: ni evento, proyección ni idempotencia sobreviven |
| IMM-01 / H2 | UPDATE/DELETE/TRUNCATE por cliente/RPC ordinaria denegados; original no cambia |
| COR-01..06 / H3 | ADD/REPLACE/VOID y cadena; gestor no se autoaprueba; base obsoleta rechazada; replay negativo/solapado rechazado; timeline cambia estado atómicamente; fuente/autor preservados |
| KIO-01..07 / H4 | Sin email, PIN erróneo genérico, rate limit persistente, device revocado, challenge expirado/reusado/cruzado rechazado, recibo aislado, sin PIN en logs/cache |
| KIO-H6-01 / H6 | Autenticación solo con código+PIN; OUT→solo CLOCK_IN, WORKING→BREAK_START/CLOCK_OUT, PAUSED→BREAK_END/CLOCK_OUT con versión correcta; challenges independientes; ejecutar uno invalida el hermano (también concurrente); caducado, reutilizado, otra acción/versión/empleado/dispositivo/tenant rechazados; PIN erróneo y código inexistente indistinguibles; dispositivo/empleado revocados y reset de credencial; límites 5/30/60 intactos; dispositivo sin consultas generales; sin PIN ni secretos de challenge en DB/logs/artefactos |
| EXP-01..05 / H5 | Export propio/empresa; snapshot consistente bajo corrección concurrente; fórmulas neutralizadas; DST/abiertos visibles; link expira sin listado público |
| RET-01..04 / H5 | No purgar antes plazo; hold bloquea; purge autorizado con manifiesto; restore reaplica bajas/purgas |
| PWA-01..03 / H6 | Offline sin ACK falso; caché no contiene API/tokens; accesibilidad teclado/lector y móvil |
| OBS-01..07 / OPS-02 | Errores centralizados con release/request_id sin secretos; métricas API/Auth/DB/fichaje; health checks; canary sintético CLOCK_IN→BREAK_START→BREAK_END→CLOCK_OUT; invariantes detectan deriva; alerta real ante fallo inducido; aislamiento de telemetría por tenant |
| RES-01..04 / OPS-02 | Retry solo de operaciones idempotentes; rollback automático de release degradada probado en staging; proyecciones reconstruibles reparables desde fuente inmutable con evidencia; frescura/éxito de backups vigilados y alertados |
| REC-01..03 / H7 | Restaurar repo y DB cifrada en entorno vacío, comprobar RLS/Auth/Storage; medir RPO/RTO; clave ausente falla sin dump plano |

Desactivar test o simular una aserción RLS en JavaScript no satisface puerta DB.
OPS-02 no puede alterar automáticamente `time_events`, decisiones/ajustes aprobados ni otra historia laboral. Los self-healings permitidos se limitan a infraestructura, reintentos idempotentes, rollback de release y proyecciones explícitamente reconstruibles.
Evidencia de cada hito: comando, entorno, resultado y limitación en CURRENT_STATE y PR.

## H4 — asignación de evidencia
| Criterio | Test real |
|---|---|
| KIO-01 | h4.py: cuenta técnica GoTrue sin membership, empleado sin email, PIN Argon2id, fichaje y actor KIOSK |
| KIO-02 | h4.py: código desconocido/PIN erróneo mismos estado/cuerpo, hash dummy y no-store |
| KIO-03 | h4.py: cinco fallos compartidos entre dispositivos, treinta por dispositivo, persistencia y éxito/reset sin saltar lock |
| KIO-04 | h4.py: OWNER/ADMIN provision/reset/revoke, JWT previo, revocación concurrente con lock primero |
| KIO-05 | h4.py: expiración, tuple completa, reset/version, consumo concurrente, matriz H2 y rollback audit |
| KIO-06 | h4.py + kiosk.test.sql: recibo aislado, retry/idempotencia/timeout, RLS cross-tenant, sin directorio/RPC humanas |
| KIO-07 | h4.py: PIN sintético generado conocido en memoria ausente en DB/logs/respuestas/artefactos, no-store y gateway sin logger sensible |

`h4.py` importa y ejecuta primero todas las suites H1/H2/H3. CI reconstruye desde vacío.
Las pruebas SQL de privilegios son pgTAP real; gateway corre el mismo módulo Deno servidor.
No PASS mientras alguna comprobación obligatoria falte o falle.

Ampliación KIO-07 / SEC-H4-01: gateway real con peers TCP sintéticos conocidos,
HMAC esperado únicamente en tabla privada, normalización IPv4/IPv6/mapped,
separación por tenant/secreto/peer, headers falsificados y JSON incapaces de elegir
bucket, límite 60/15 min entre dispositivos persistente tras reinicio, PIN correcto
no desbloquea, expiración por reloj servidor y límites anteriores intactos.
Escanear IP sintética en DB completa, logs, respuestas y artefactos; escanear todos
los digests contra logs/respuestas/artefactos/audit laboral. RLS real: SELECT/INSERT/
UPDATE cross-tenant y modificación de identidad denegados. Sin mocks de RLS.

## H6 — asignación de evidencia
Navegador real: Playwright + Chromium en proyectos escritorio (1280×800) y móvil (Pixel 5) contra
Supabase local (Auth, PostgREST, Storage, PostgreSQL), gateway H4 y firmador H5 reales. Datos
sintéticos por prueba; los efectos se comprueban en PostgreSQL. Detalle en `docs/UI_PWA.md`.

| Criterio | Evidencia |
|---|---|
| PWA-01 | `pwa.e2e.ts`: sin red no hay acciones ni peticiones de fichaje; shell servido por el SW; cambio de estado en servidor visible al reconectar sin reproducir clics. `employee.e2e.ts`: ACK perdido y 5xx → resultado desconocido y reintento con el mismo `request_id` (un solo evento) |
| PWA-02 | `pwa.e2e.ts`: Cache Storage solo contiene la lista precargada; sin API/Auth/tokens/registros/exportaciones; localStorage solo sesión Auth. `kiosk.e2e.ts`: PIN, credencial y tokens ausentes de almacenamiento, cachés, consola, logs y artefactos. `sw-policy.test.ts`, `scan_secrets.mjs` |
| PWA-03 | `a11y.e2e.ts`: axe WCAG 2.2 A/AA + buenas prácticas en todas las pantallas y diálogos (ambos viewports), teclado real, orden y foco visible, diálogos, reflujo a 320 px, texto al 200 % y tamaño de objetivos |
| Empleado | `employee.e2e.ts`: login, ciclo completo, salida desde pausa, doble clic, ACK perdido, error servidor, rechazos, revocación, evidencia, corrección con revisión y aprobación independiente, exportación propia |
| OWNER/ADMIN | `manager.e2e.ts`: tenant correcto, denegación cross-tenant con sesión real, cambio de tenant, empleados sin email, roles, invitación, bandeja con independencia/obsolescencia/negativa del servidor, clasificación, exportación y entrega controlada, horarios |
| Kiosco | `kiosk.e2e.ts` (navegador real + gateway Deno + PostgreSQL): preparación y PIN desde la gestión, empleado sin email ficha OUT→WORKING→PAUSED→OUT con solo las acciones legales, confirmación solo tras ACK, PIN erróneo/código inexistente genéricos, ACK perdido y timeout con recuperación de un único evento, doble toque, challenge reutilizado/caducado, dispositivo revocado, limpieza del recibo (10 s) y de la pantalla identificada (< 15 s, medida en la página), sin PIN/código/credencial/JWT/challenges en almacenamiento, cachés, consola, logs ni artefactos; axe en todos los pasos del terminal. Backend: `kiosk_identification.test.sql` y `kio_h6.py` (KIO-H6-01) |

## OPS-02 — asignación de evidencia
Stack real efímero (Supabase local: Auth, PostgREST, Storage, PostgreSQL 17), releases construidas desde
el commit bajo prueba con el gateway H4/KIO-H6-01 y el firmador H5 reales, y tenants exclusivamente
sintéticos. Los fallos se inducen de verdad (saltos HTTP/TCP en loopback, contenedores detenidos o
pausados, artefactos de release defectuosos, deriva privilegiada en la base efímera) y los detecta el
código operativo sin modificar (`tests/integration/ops02.py`, puerta `.github/workflows/ops02.yml`).

| Criterio | Evidencia |
|---|---|
| OBS-01 | `test_core.py` (allowlist, campos obligatorios, correlación, mapeo de excepciones sin texto) + `ops02.py`: todos los eventos de scripts y gateways cumplen `ops/contract.json`, llevan release/commit y sus `request_id` casan uno a uno con el audit; escáner final sin secretos, PIN, emails, nombres, códigos, motivos ni ids de registro en logs, métricas, alertas e informes |
| OBS-02 | `test_core.py` + `ops02.py`: contadores iguales a un recuento independiente, histograma de latencia, fallos/`UNKNOWN_OUTCOME`/`VERSION_CONFLICT` por acción, fallos de PIN y bloqueo del kiosco, jobs y backups; telemetría del navegador agregada vía RPC de solo escritura (identificadores rechazados); etiquetas solo de enumeraciones acotadas |
| SEC-OPS-01 | `ops_observability.test.sql` (48 aserciones) + `ops02.py` (16 comprobaciones por HTTP directo a PostgREST, sin navegador) + `test_core.py`/`test_resilience.py` + `telemetry.test.ts`: llamadas consecutivas cortadas en la cuota, `count=9999`, 100 series, releases aleatorias rechazadas sin columna ni fila, 2×40 llamadas simultáneas con exactamente la cuota aceptada, segunda identidad no bloqueada, reset al expirar la ventana y purga, límites globales intencionados, anon, identificadores y valores fuera de vocabulario rechazados sin escritura; seudónimos sin uid/email fuera de métricas, logs y alertas; historia, proyección, reparaciones, alertas y release intactas tras el abuso; crecimiento acotado |
| OBS-03 | `ops02.py`: app, API, Auth, PostgreSQL, gateway y firmador UP; API 5xx, Auth rechazando, latencia, PostgreSQL rechazando, contenedor Auth detenido y PostgreSQL pausado → DOWN/DEGRADED y recuperación; sin URLs, hosts, claves ni datos; no crea fichajes |
| OBS-04 | `ops02.py`: canary web y kiosco OUT→…→OUT con respuesta, estado, versión, `server_at`, RLS, audit e idempotencia y reintento seguro de la operación confirmada; repetible; ciclo interrumpido → rotación sin cerrar la sesión; empleado desactivado → FAIL |
| OBS-05 | `ops_observability.test.sql` + `ops02.py`: deriva de proyección, originales borrados/alterados, audit cross-tenant, ajuste de decisión rechazada, guarda deshabilitada, sesión abierta antigua y exportación atrasada detectados; el comprobador nunca modifica historia |
| OBS-06 | `test_core.py` + `ops02.py`: catálogo con runbook, CRITICAL→pager y WARNING→ticket en un sink real, formato `fichaje.alert.v1` validado y RESOLVED al recuperarse |
| OBS-07 | `ops_observability.test.sql` + `ops02.py`: roles técnicos NOLOGIN/NOINHERIT/NOBYPASSRLS, logins sin privilegios de tabla, monitor solo agregados, revisión por tenant, OWNER/ADMIN/EMPLOYEE/anon sin acceso a funciones ni tablas OPS |
| RES-01 | `test_core.py` + `ops02.py`: ACK perdido tras commit → mismo payload y clave, una mutación/audit/recibo; error permanente un intento; 5xx con backoff acotado; circuito abierto; operación sin clave nunca reintentada |
| RES-02 | `test_resilience.py` + `ops02.py`: release sana promovida; candidata con defecto real (gateway que no registra; app sin asset) detenida, alertada, rollback a la sana, health y canary en verde y alertas resueltas. Arnés CI aislado y efímero; la repetición en staging es puerta de H7 |
| RES-03 | `ops_observability.test.sql` + `ops02.py`: solo `private.employee_state`; `--check` en transacción READ ONLY no escribe; reconstrucción exacta, segunda ejecución no-op, historia byte a byte igual, evidencia y audit; fuente alterada → BLOCKED |
| RES-04 | `test_resilience.py` + `ops02.py`: artefacto real de `backup_repo.sh` con checksums, bundle y restore de ensayo; fallido/antiguo/ausente/sin artefacto/corrupto/sin checksums alertados; backup DB `NOT_CONFIGURED` nunca verde; `ops-monitor.yml` vigila el backup real a diario |

## H7 — asignación de evidencia (piloto comercial; 2026-09-28)
Forma de staging en local: Supabase local efímero, funciones Deno reales con firma de ingreso, runtime real
de Cloudflare Pages (workerd vía wrangler 4.142.0) sirviendo la app compilada y `/gateway/*`, tenants
exclusivamente sintéticos y secretos aleatorios por ejecución. Puerta CI: `.github/workflows/h7.yml`.
**El staging remoto, las rutas de alerta reales, la custodia real de claves, la revisión independiente y la
aceptación de empresas piloto no existen todavía: esos criterios quedan BLOCKED.**

| Criterio | Evidencia | Estado |
|---|---|---|
| Borde mismo origen | `h7_edge.py`: rutas/métodos cerrados, sin CORS, origen y fetch-metadata, límites 8 KiB/1 KiB (también chunked), `no-store`, cabeceras estáticas, CSP, HSTS, sin source maps; `edge-gateway.test.ts` | PASS local |
| Sin bypass directo | `h7_edge.py`: 7 firmas inválidas + health y firmador directos → 403 antes de JSON/JWT/SQL, sin contadores consumidos; sin puerto local ni secreto, gateway y firmador no arrancan; `ingress_test.ts` | PASS local |
| SEC-H4-01 real | `h7_edge.py`: peer = proxy, cabeceras ignoradas, 1 bucket por tenant, bloqueo de tenant medido (60 fallos), otro tenant intacto | PASS local; peer de Supabase Edge **BLOCKED** |
| Verificador de staging | `scripts/staging/verify_staging.py` ejecutado dentro de `h7_edge.py`: 30 comprobaciones PASS + 3 de TLS omitidas solo en local | PASS local; remoto **BLOCKED** |
| Fallo inducido OPS-02 | `h7_release.py`: release con firma rota promovida con el deployer del borde → detección 3,7 s, página y ticket, rollback, RESOLVED, sin tocar historia laboral | PASS local; staging **BLOCKED** |
| Rutas de alerta reales | `test_alert_routes.py` (PagerDuty Events v2 / GitHub Issues contra receptores locales con el formato real, sin PII) | Adaptadores PASS; entrega real **BLOCKED** (sin proveedor/credenciales) |
| Backup cifrado y restore (REC-01..03) | `rec.py`: pg_dump 17 \| age con verify-full, destrucción de la fuente, restore en entorno vacío, journal independiente, validación completa, negativos de clave/ciphertext, PREPARED sin resolver → BLOCKED; `backup.test.ts` | PASS local; destino/custodia reales **BLOCKED** |
| Carga del piloto | `h7_load.py` (24 comprobaciones): 2 empresas × 100 empleados, web con 20 peticiones concurrentes (p95 ≤ 248 ms con 4 CPU, ≤ 377 ms con 2 CPU), pico de kiosco con 8 kioscos y cadencia humana (p95 ≤ 607 ms / 744 ms); límites medidos y no aprobados como objetivo: 8 kioscos sin pausas 0,82–1,22 s y 20 autenticaciones simultáneas 1,8–2,9 s (Argon2id serializado); sin errores, duplicados, pérdidas ni deadlocks | PASS local; el perfil sin pausas superó 1 s (1053,7 ms) en una ejecución; staging **BLOCKED** |
| Respuesta a incidentes | `h7_incident.py` y `docs/drills/IR-2026-09-28.md` | PASS local (tiempos humanos pendientes) |
| Documentación legal | `docs/legal/` (17 plantillas) y revisión en `COMPLIANCE.md` | Plantillas; verificación con fuentes primarias **BLOCKED** |
| Runbook del piloto | `docs/PILOT_RUNBOOK.md` | No ejecutado con empresa real |


## H7 — decisión de aceptación final sintética (2026-09-29)
Por decisión expresa del usuario, H7 se cierra con **validación end-to-end de la aplicación final mediante una empresa ficticia**, no con un piloto de 1-2 empresas reales.

Puerta de salida H7:
- todos los workflows obligatorios del head final en PASS;
- verify_staging.py remoto sin --local: 0 FAIL y 0 SKIPPED;
- aislamiento multiempresa y SEC-H4-01 verificados en el entorno remoto;
- una organización ficticia estable con identidades sintéticas OWNER, ADMIN y EMPLOYEE y un kiosco sintético;
- flujo real desde la UI: login, alta/configuración, CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT, salida desde pausa, corrección con aprobación independiente, consulta del registro y exportación;
- ningún secreto ni dato real en GitHub, logs o artefactos;
- revisión final del usuario sobre la app desplegada.

No son bloqueadores para cerrar H7 sintético: contratar un tercer proyecto Supabase, ejecutar un restore en un segundo Supabase gestionado, configurar un proveedor real de guardia o hacer un piloto con una empresa real. Las suites locales/CI existentes de fallo, rollback, carga, incidente y REC se conservan y no se desactivan.

Antes del **primer cliente real / producción**, habrá una puerta operativa separada: alertas reales, estrategia de backup/restore viable y probada en el entorno que se vaya a operar, respuesta a incidentes, revisión legal/seguridad necesaria y autorización expresa de producción. Esa puerta puede requerir gasto y se decidirá entonces.


## GO-LIVE — criterios de aceptación
| ID | Resultado exigido |
|---|---|
| GL-01 | HEAD candidato con CI, Database, E2E H6, OPS-02 y H7 en success |
| GL-02 | Security Advisor revisado; ningún hallazgo crítico o warning no explicado queda abierto |
| GL-03 | Proyecto productivo ACTIVE_HEALTHY, misma migración que staging y sin tenants reales antes del alta |
| GL-04 | `VITE_DEPLOYMENT_TIER=production` rechaza Supabase de staging y gateways absolutos; staging rechaza Supabase productivo |
| GL-05 | Alerta real sintética entregada por una ruta operativa sin PII |
| GL-06 | Backup DB cifrado real, destino privado y restore probado en entorno vacío |
| GL-07 | Journal independiente disponible y replay/reconciliación probados |
| GL-08 | Simulacro de incidente con corte, recuperación y reapertura documentados |
| GL-09 | Revisión legal vigente y kit contractual/informativo listo para el primer cliente |
| GL-10 | La release productiva solo puede generarse desde el HEAD de `main` que sea merge de PR y tenga los cinco gates verdes; branch protection se usa solo si el plan la permite |
| GL-11 | Cloudflare productivo separado de staging y verificado end-to-end |
| GL-12 | Autorización expresa posterior para producción real |

Ningún criterio documental sustituye la evidencia remota cuando el gate exige infraestructura real.
