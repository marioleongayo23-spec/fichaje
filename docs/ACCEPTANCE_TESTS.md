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
| Kiosco | `kiosk.e2e.ts`: preparación y revocación reales, dispositivo sin directorio ni navegación y en fallo seguro, reset de PIN mostrado una vez, contrato H4 real (PIN erróneo/código desconocido genéricos, ACK, recuperación de recibo, challenge reutilizado y caducado, dispositivo revocado). Flujo del terminal solo con stub (`kiosk-terminal.test.tsx`): **bloqueado por H4-KIOSK-01** |
