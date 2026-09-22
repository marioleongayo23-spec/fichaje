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
