# Seguridad y RLS — contrato de implementación
## Denegación por defecto
ENABLE + FORCE ROW LEVEL SECURITY en tablas tenant; anon sin permisos de datos ni RPC de negocio.
RLS no reemplaza GRANT: authenticated solo SELECT permitido y EXECUTE explícito. INSERT/UPDATE/
DELETE/TRUNCATE revocados. Schema private fuera de API, sin USAGE cliente. Views con security_invoker
(o lecturas RPC) para no eludir RLS. Storage privado, sin listado global ni URLs permanentes.

| Recurso | EMPLOYEE | ADMIN | OWNER | Kiosco |
|---|---|---|---|---|
| Organización | Su empresa activa | Su empresa | Su empresa | Sin lectura directa |
| Membresías | Su propia fila activa | Su empresa | Su empresa | Ninguna |
| Empleados | Su empleado vinculado | Su empresa | Su empresa | Ninguna |
| Políticas | Aplicables a su empleado | Su empresa | Su empresa | Ninguna |
| Sesiones/eventos/ajustes/solicitudes/decisiones/clasificaciones | Solo empleado propio | Su empresa | Su empresa | Solo recibo de acción |
| Audit log | Evidencia propia filtrada mediante RPC | Su empresa | Su empresa | Ninguna |
| Gestión EMPLOYEE/kiosco | No | Sí | Sí | No |
| Gestión ADMIN/transferir OWNER | No | No | Sí | No |
| Proyecciones/idempotencia/PIN/holds/export_jobs | RPC autorizada, sin SELECT directo | Igual | Igual | Gateway acotado |

Predicado de lectura de eventos: membresía activa de auth.uid() en row.organization_id Y
(role in OWNER/ADMIN O employees.membership_id = membresía actual Y employees.id = row.employee_id).
employees.active impide fichar pero no elimina derecho a historial mientras tenga acceso autorizado.
No usar un SELECT directo recursivo de memberships en su propia política: helper privado
SECURITY DEFINER retorna boolean/rol del auth.uid actual para org, sin parámetro user elegible por cliente;
propietario técnico mínimo y search_path vacío. Revocar EXECUTE PUBLIC, conceder solo helpers necesarios.
Auditoría propia por RPC proyecta columnas seguras y filtra employee_id; no expone otros usuarios.

## RPC
Funciones SECURITY DEFINER: owner dedicado sin superuser ni BYPASSRLS para mutaciones; políticas
de ese rol acotadas y comprobación explícita de actor+tenant. Helper de membresía usa rol técnico
separado con SELECT solo organizations/memberships para comprobar empresa activa y evitar recursión. Objetos schema-qualified, search_path='',
sin SQL dinámico, auth.uid no NULL, argumentos/longitudes validados. Revocar EXECUTE de PUBLIC/anon.
No permitir al rol técnico cambiar roles, desactivar triggers o concederse permisos.
Revalidar organización/membresía/empleado en transacción; expected_version y FK compuestas.
No confiar en JWT user_metadata ni organization_id recibido sin comprobación.
Toda alta, baja, invitación y cambio de rol es idempotente, auditado y mantiene un OWNER activo.
Alta de la primera organización por flujo controlado servidor; no signup público autootorgado.

### Adaptadores Auth de H1
El esquema Auth pertenece a Supabase. `private.request_uid()` y
`private.verified_auth_email(uuid)` son adaptadores escalares de lectura, propiedad de postgres,
con search_path vacío y EXECUTE explícito: identidad actual para los helpers/RLS y email
verificado/no bloqueado solo para el escritor. No consultan ni modifican tablas tenant.
Los helpers de membresía mantienen propietario lector mínimo y las mutaciones propietario
escritor sin BYPASSRLS. No se heredan roles autenticados ni service_role para acceder a Auth.

## Kiosco sin email (H4)
OWNER/ADMIN provisiona dispositivo: identidad Auth técnica única, sin memberships; token renovable
solo en dispositivo autorizado y revocable. Gateway valida JWT, device_id activo, tenant y caducidad.
Empleado introduce código + PIN mínimo 8 dígitos generado aleatoriamente; nunca listado de empleados.
PIN hash Argon2id (mínimo 19 MiB, t=2, p=1, recalibrar) con salt por credencial y pepper en secret store.
Rate limit persistente: 5 intentos fallidos/empleado/15 min y 30/dispositivo/15 min; IP de forma
minimizada como defensa adicional, nunca prueba de identidad. Respuesta genérica y tiempo uniforme.
Reset por gestor auditado, revoca credencial anterior; no recuperar PIN original ni registrarlo.
Tras validación (KIO-H6-01), el servidor obtiene empleado, estado y versión autoritativos y emite
un challenge de 256 bits por cada acción legal de ese estado (nunca uno genérico): hash almacenado,
TTL 60 s, ligado a tenant, empleado, dispositivo, acción, expected_version, request_id propio y
versión de credencial, agrupados en un grant. El kiosco solo recibe estado, versión, acciones y
challenges; nunca el identificador del empleado ni acceso libre a estado, eventos o directorio.
RPC solo para rol backend dedicado (no usar service_role como acceso universal habitual); consume
challenge y ficha en la misma transacción, e invalida los challenges hermanos del grant.
Reintento mismo request_id devuelve recibo previo tras reautenticar dispositivo/empleado;
no consume de nuevo challenge ni permite cambiar payload. Revocación gana si obtiene lock primero.
Kiosco sin consultas libres, exports ni roles administrativos; limpia PIN/recibo a los 15 s, no persistir
credenciales de empleado. Solicitudes de corrección asistidas autentican empleado del mismo modo.
PIN reduce fricción pero no prueba presencia física ni evita que se comparta; empresa debe aceptar
riesgo y procedimiento antes del piloto. Sin conexión no confirmar fichaje.

## Observabilidad segura — OPS-02
Telemetría y alertas siguen minimización y least privilege. Registrar solo lo necesario para operar: `request_id`, operación, release/commit, clase de error, latencia y referencias técnicas acotadas. No registrar JWT, refresh tokens, PIN, challenges, emails, motivos de corrección, payloads de fichaje/exportación ni contenido laboral completo. Acceso a dashboards/logs restringido y auditado; retención definida antes de producción.

La observabilidad no crea un canal de soporte global que eluda RLS. Las sondas funcionales usan únicamente tenant sintético; los checks de invariantes sobre producción son read-only y tenant-scoped o agregados sin contenido personal. Alertas deben evitar enumeración cross-tenant.

Un agente automático o IA puede diagnosticar, proponer tests/fixes y abrir cambios revisables, pero no obtiene autoridad para editar historia laboral en producción. Rollback/restart/retry solo bajo reglas previamente probadas; cualquier reparación de proyección se deriva de fuente inmutable y deja evidencia operativa.

Implementado en OPS-02 (2026-09-26): eventos construidos por allowlist (claves y valores de
`ops/contract.json`; lo desconocido se descarta, las excepciones se reducen a una clase estable sin texto
SQL, parámetros ni trazas). Métricas solo con etiquetas enumeradas: nunca `employee_id`, `event_id`,
`request_id`, tenant ni email. `request_id` es la única correlación y solo aparece en eventos. Los logins
técnicos heredan un único rol de entrada sin privilegio de tabla; el monitor ve recuentos agregados sin
tenant; la revisión humana exige un tenant; la reparación solo reconstruye `employee_state`. Ningún rol
OWNER/ADMIN/EMPLOYEE/anon alcanza funciones o tablas OPS; la única RPC pública OPS es la ingesta de
agregados del navegador. Los canaries usan tenants sintéticos y RLS los limita a su empleado. La inyección
de fallos exige `OPS_FAULT_INJECTION=1` y destinos loopback. `scripts/ops/leakscan.py` y
`scripts/scan_secrets.mjs` (reglas ampliadas: claves age, tokens GitHub, URLs firmadas, nombres de DSN
técnicos) escanean logs, métricas, alertas, informes y artefactos.

SEC-OPS-01 (auditoría independiente, 2026-09-26). Causa: la ingesta del navegador solo validaba forma y
vocabulario; cualquier identidad `authenticated` podía repetir llamadas sin límite con hasta 100 series y
9.999 eventos por serie y elegir `p_release`, creando combinaciones nuevas sin cota (contaminación de
métricas, cardinalidad y crecimiento no acotados). Corrección en servidor (los límites de
`src/lib/telemetry.ts` no son una defensa): la RPC solo acepta `p_batch` y el almacén no tiene columna de
release; claves exactas, vocabulario cerrado, ≤100 series distintas, 1..1000 eventos por serie y suma de
duraciones dentro de los límites de sus cubos (+Inf ≤ 120 s); cuotas persistentes y concurrency-safe por
identidad y ventana de 5 min (30 llamadas contando las rechazadas, 2.000 eventos, 200 series) y límites
globales intencionados por ventana (5.000 identidades, 200.000 eventos, 1.000 filas por cubo), ajustables
solo por el propietario de la base en `private.ops_ingest_limits`. Un rechazo por cuota confirma el intento y
responde `{"accepted":0,"limited":true}`; el navegador descarta ese lote. El emisor se representa con
`sha256(sal de la ventana ‖ uid)`: sin uid, email, membresía, empleado, nombre ni código; solo se conservan la
ventana actual y la anterior (la primera llamada de cada ventana purga el resto; sin actividad persisten
hasta la siguiente llamada) y la sal desaparece con su ventana. Nunca aparece en métricas, logs, alertas ni
respuestas y no es una dimensión. Los cubos del navegador se retienen 7 días. Esta telemetría es no
confiable por diseño: no alimenta alertas, gate de release, rollback ni reparaciones; las señales críticas
proceden de eventos de servidor, health, canary, invariantes y backups. Riesgo residual: una identidad
autenticada puede sesgar, dentro de su cuota, agregados informativos; la inundación HTTP de llamadas
inválidas (rechazadas sin escribir) corresponde a la capa de plataforma de H7.

## Amenazas y respuesta
- Tenant spoofing, referencias cruzadas, invitaciones y roles: RLS + FK + pruebas con dos tenants.
- Doble clic/replay/carreras: clave persistente + locks + versión + transacción.
- XSS: escapar React, sin dangerouslySetInnerHTML, CSP futura, dependencias fijadas/lockfile.
- Robo token: TLS, revocación, expiración, no logs; sesiones humanas distintas de kiosco.
- Export injection: autorización al generar/descargar, CSV neutralizado, objetos privados TTL.
- Filtración secretos: VITE solo configuración pública; .env, dumps, rclone y backups ignorados.
- Admin DB: acceso excepcional registrado y mínimo; backup externo, restore ensayado.
- Caída: no ACK optimista; contingencia y recuperación documentada.
Incidente: contener/revocar, preservar evidencia mínima, evaluar afectados y obligaciones RGPD,
notificar al responsable sin dilación, documentar decisión y corrección. Ensayo obligatorio H7.
Referencias: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[Password storage OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

### SEC-H1-01 — aislamiento del escritor por transacción
La migración `20260922000100_h1_security_audit.sql` sustituye las políticas universales del
escritor por `organization_id = private.scoped_tenant('member')` (id en la raíz).
Sin contexto protegido no hay filas visibles ni INSERT permitido; WITH CHECK impide mover tenant.
`private.mutation_context` liga xid8, backend, principal y ruta a un único tenant. No se utiliza
un GUC como autoridad. El escritor no tiene SELECT/DML sobre el contexto, ni EXECUTE sobre
su constructor genérico. Una segunda autorización a otro tenant en la misma transacción falla,
incluso si la identidad pertenece a ambos. El contexto anterior nunca sirve en otra transacción;
el siguiente bind limpia las filas visibles de transacciones ya terminadas (MVCC).

`fichaje_guard` solo lee organizations/memberships/invitations y administra el contexto;
no puede modificar datos tenant. Expone gates privados con validación de miembro gestor,
o token+email verificado+tenant+emisor+caducidad para aceptación. `fichaje_bootstrap` y
`fichaje_acceptor` son roles separados sin herencia entre rutas; sus políticas usan sus propios
scopes y sus GRANT se limitan al alta requerida. La aceptación solo puede insertar la identidad
actual con el rol invitado (nunca OWNER); bootstrap solo el OWNER verificado autorizado.
Todos son NOLOGIN/NOBYPASSRLS, sin CREATE tras migrar. FORCE RLS se conserva.
El constraint diferido de OWNER usa el lector técnico para comprobar la invariante aunque el
scope de bootstrap ya se haya liberado. Las RPC ordinarias mantienen el lock de organización.
Los tests con SET ROLE suponen el contexto JWT que PostgREST valida: no se ofrecen credenciales
SQL ni acceso a SET ROLE/set_config mediante la API. El operador PostgreSQL sigue siendo privilegiado.

### AUD-H1-01 — evidencia mínima reconstruible
`safe_details.before/after` registra role/active/version para membresías y
active/membership_id/version para empleados (before null en altas). La transferencia incluye
`changes` con los UUID y before/after de ambas membresías. Las versiones ordenan inequívocamente
los cambios aunque dos timestamps coincidan. Se conserva request_id para correlación e idempotencia.
Alta OWNER y aceptación también registran la asignación inicial; invitación registra únicamente rol.
No se incluye email, token, nombre, código de empleado ni payload completo. El audit se inserta
con los datos bajo el mismo lock/transacción; un fallo revierte datos y recibo. Replays no duplican.

### H2 — fichaje propio sin capacidad administrativa
`private.member_scope`, `private.authorize` y los permisos H1 permanecen sin cambios:
un EMPLOYEE no recibe capacidad member. `fichaje_clock` es un rol NOLOGIN/NOINHERIT/
NOBYPASSRLS separado, sin escritura de empleados/membresías/políticas.
El guard verifica empleado propio activo, membresía activa y tenant activo antes de emitir
capacidad clock ligada a xid8/backend/principal/tenant y employee_id. El rol no puede crear,
borrar ni reasignar el contexto ni invocar gates H1. RLS restringe estado/sesiones/eventos al
empleado de esa capacidad; audit y recibos solo aceptan la operación record_time_event.
Tras obtener el lock de organización compartido con H1 se revalidan organización, membresía
y empleado antes del replay; después se bloquea employee_state. El bind ocurre una sola vez:
no se repite limpieza de contextos bajo el lock de organización, evitando invertir locks.
El guard añade solo lectura de employees para validar el vínculo; no recibe mutaciones tenant.
`fichaje_state_reader` solo lee el estado propio o el autorizado a gestores mediante RLS;
no emite capabilities ni escribe. Desactivar empleado bloquea fichaje/replay, no borra historial.

### H3 — capacidades de corrección
`fichaje_correction` NOLOGIN/NOINHERIT/NOBYPASSRLS no hereda H1/H2 ni puede invocar sus
gates, alterar identidad o insertar/modificar originales. Dos rutas protegidas acotadas a
tenant/empleado: `correction_submit` solo inserta solicitudes; `correction_decide` permite
las decisiones, ajustes, sesiones añadidas y proyección. RLS valida además identidad del
solicitante y la independencia del decisor en cada INSERT de solicitud/decisión.
El guard solo gana lectura de solicitudes para validar esas reglas, sin DML de negocio.
Bind único antes del lock de organización; revalidación después del lock, incluso antes
de recuperar recibos. No excepciones para un único gestor. Lector de timeline separado,
solo lectura y RLS propio/gestor; sin mutación. Originales y cuatro tablas de evidencia
mantienen triggers de inmutabilidad. Todos los FK de ajuste incluyen tenant y empleado.

La independencia también conserva el vínculo afectado capturado al solicitar y comprueba
el autor de fichajes originales mediante el lector RLS. Desvincular/reasignar el empleado
antes o después de solicitar no permite al autor de esos fichajes aprobarlos. El guard
no gana lectura global de eventos; el helper lector solo ve el historial autorizado.

### H4 — frontera concreta y pruebas
`fichaje_gateway` solo USAGE + EXECUTE de cinco funciones privadas: preflight/apply gestor,
auth begin/finish y record. No tablas, membresías ni herencia de otros roles. El login SQL
servidor valida JWT primero y fija identidad transaccional; no se entrega a dispositivo.
`fichaje_kiosk` NOLOGIN/NOINHERIT/NOBYPASSRLS es definer de estas funciones; las rutas
kiosk_admin/device/clock de capability protegen tenant y empleado. RLS + grants por columna
separan lectura/verificación de credenciales, provisioning y consumo. No permisos UPDATE,
DELETE o TRUNCATE sobre originales. El guard lee solo identidad del dispositivo adicional,
no hashes/challenges; mantiene las capacidades H1/H2/H3 independientes.
La exclusión dispositivo/membership es bidireccional y serializada por identidad Auth.
El reset cambia hash/version sin eliminar bloqueos activos; no permite recuperar el PIN.
Entrega cifrada para clave pública del gestor evita PIN/password en respuestas en claro.
El pepper nunca entra en parámetros SQL. Tiempo mínimo de respuesta 300 ms + trabajo
Argon2 dummy en fallo de autenticación; no prometer tiempo constante bajo saturación.
Detalles reproducibles, recuperación de recibo y prueba de fugas en `supabase/README.md`.

### SEC-H4-01 — defensa adicional de red
El gateway Deno usa exclusivamente `Deno.ServeHandlerInfo.remoteAddr` (peer TCP
establecido por el runtime/SO). No lee `Forwarded`, `X-Forwarded-For`, `X-Real-IP`,
`CF-Connecting-IP` ni otra cabecera de red; los campos JSON no admitidos se rechazan.
Sin peer TCP válido, autenticación denegada: no fallback a datos del cliente.
IPv4 se valida en decimal estricto; IPv6 se canonicaliza y las IPv4 mapeadas se
unifican con IPv4. Inmediatamente se calcula HMAC-SHA256 sobre dominio
`kiosk-network-v1`, UUID tenant en minúsculas y dirección normalizada, separados
por salto de línea. Solo ese digest llega a PostgreSQL, en
`private.kiosk_network_buckets`, FORCE RLS y contexto de tenant/dispositivo activo.
`KIOSK_NETWORK_SECRET`: aleatorio, mínimo 32 bytes en base64, exclusivamente backend,
independiente de `KIOSK_PEPPER` (igualdad rechazada), nunca VITE/GitHub/PostgreSQL.
CI genera ambos de forma independiente y efímera. El HMAC impide un diccionario
público de IP; no es anonimato frente a quien obtenga el secreto.

Límite adicional: 60 fallos/peer/tenant/15 minutos, compartido entre dispositivos.
Usa el mismo lock de organización, transacción y reloj servidor; reserva intento
y lo descuenta solo tras PIN válido y ausencia de TODOS los bloqueos previos.
El fallo número 60 bloquea 15 minutos desde ese fallo. El éxito no levanta un
bloqueo vigente. Reiniciar gateway no reinicia contadores; al expirar ventana y
bloqueo, el siguiente intento reinicia el bucket. Los límites 5/empleado y
30/dispositivo conservan sus reglas. Nunca es prueba de identidad ni autorización.
No se incluye IP/digest en respuestas, logs, audit laboral ni frontend.

Frontera de despliegue: el listener TCP es la fuente confiable, no una cabecera
que un proxy prometa añadir. Detrás de proxy/NAT se agrupa por su dirección real
de conexión (posible bloqueo compartido conservador), no por la IP original
declarada. Un cliente no elige el bucket enviando cabeceras. No usar un adaptador
que fabrique remoteAddr desde headers. Si la plataforma Edge no proporciona
metadata TCP confiable, esta ruta falla cerrada y requiere adaptar/verificar
la infraestructura antes del piloto; H4 no despliega producción. Rotar el secreto
cambia buckets de red; hacerlo de forma controlada, manteniendo los límites
persistentes empleado/dispositivo. Estos hashes operativos no son historia laboral;
su política de retención corresponde al H5 aún pendiente.

### H6 — frontend
El navegador solo recibe URL y clave publicable. Autorización siempre en servidor: ocultar botones es
presentación. Sin `dangerouslySetInnerHTML`, `eval` ni logs de aplicación (lint `no-console`); textos
del backend se renderizan como texto. CSP estricta en el build. Almacenamiento limitado a la sesión de
Supabase Auth (humana y de dispositivo con claves y clientes separados) y a identificadores públicos
del kiosco; nunca PIN, códigos, recibos, registros, exportaciones ni URLs firmadas. El service worker
cachea solo el shell listado en el build y no intercepta API, Auth, Storage, funciones ni gateway.
Tokens de invitación y claves RSA de entrega se generan en el navegador; solo el hash o la clave
pública salen de él y los secretos entregados se muestran una vez. Guardas de código fuente y
`scripts/scan_secrets.mjs` fallan la CI ante service_role, claves secretas, JWT, pepper o credenciales
PostgreSQL en el build o en artefactos de prueba. Contrato de identificación del kiosco (KIO-H6-01)
en `docs/UI_PWA.md` y `supabase/README.md`.

### H7 — borde del mismo origen, firma de ingreso y plataforma (2026-09-28)
**Borde** (`edge/gateway.ts`, Pages Function `functions/gateway/[[path]].ts`): única entrada del navegador a las
funciones de servidor. Tabla cerrada de rutas y métodos (`/gateway/kiosk/{provision,revoke,reset,authenticate,
record}` POST, `/gateway/export-link` POST, `health/{live,ready}` GET; resto 404, método ajeno 405 con `Allow`,
`OPTIONS` 405 sin cabeceras CORS); `Sec-Fetch-Site` distinto de `same-origin` u `Origin` ajeno → 403; solo JSON;
cuerpo ≤ 8 KiB (kiosco) / 1 KiB (firmador), leído en streaming aunque falte o mienta `Content-Length`; respuesta
≤ 64 KiB, solo JSON 2xx/4xx/5xx del upstream (redirecciones y otros tipos → 502). Hacia arriba solo viajan
`Authorization`, `Content-Type` y la firma: nunca cabeceras de IP o reenvío, cookies ni `Origin`. Sin reintentos
(una respuesta perdida sigue siendo «desconocida» y el cliente reintenta con el mismo `request_id`), timeout de
15 s, `Cache-Control: no-store`, sin logs de cuerpos, tokens ni IP. Upstream solo HTTPS sin credenciales ni query
(HTTP únicamente en loopback para ensayos); sin configuración válida → 503 `EDGE_NOT_CONFIGURED`.

**Firma de ingreso** (`supabase/functions/_shared/ingress.ts`, compartido por borde y funciones):
`x-fichaje-edge: v1.<ts>.<HMAC-SHA256>` sobre dominio, instante, método, función, ruta y SHA-256 del cuerpo;
ventana ±60 s; secreto base64 ≥ 32 bytes distinto del pepper y del secreto de red (arranque rechazado si
coinciden). En plataforma (sin puerto local) o con `FICHAJE_ENV=staging|production` la firma es obligatoria: sin
secreto la función no arranca. Una petición sin firma válida recibe 403 tras leer solo sus bytes acotados y
antes de interpretar JSON, validar JWT o tocar SQL: la URL pública `*.supabase.co/functions/v1/*` no es una
entrada alternativa (en `h7_edge.py`: sin firma, caducada, futura, de otra ruta, de otros bytes, de otro secreto
y malformada, más health y firmador directos; ningún contador de PIN ni de red consumido). Rotación sin corte con `FICHAJE_INGRESS_SECRET_PREVIOUS` (ensayada en `h7_incident.py`).
`verify_jwt=false` (`supabase/config.toml`, `PlatformDeployer`) porque los health checks no llevan JWT y cada
función valida el JWT contra Auth (`/auth/v1/user`, que también detecta sesiones revocadas).

**SEC-H4-01 tras el borde** (medido en local con workerd real; peer real de Supabase Edge sin verificar):
el gateway ve un único peer TCP (el proxy) ⇒ un bucket de red por tenant; `X-Forwarded-For`, `X-Real-IP`,
`CF-Connecting-IP`, `True-Client-IP` y `Forwarded` nunca eligen el bucket; 60 fallos en 15 min bloquean la
identificación en kiosco de **toda la empresa** (efecto conservador aceptado, no se debilita); otra empresa tras
el mismo proxy no se ve afectada. Detección: `KIOSK_AUTH_ABUSE`. Si en staging `info.remoteAddr` no fuera
fiable, el gateway ya falla cerrado (403) y el piloto queda BLOCKED.

**Cabeceras estáticas** (`_headers` generado en el build): CSP (`default-src 'self'`, `script-src 'self'`,
`connect-src 'self' <origen Supabase>`, `object-src 'none'`, `frame-ancestors 'none'`), HSTS 1 año (sin
`includeSubDomains`/`preload` hasta decidir el dominio), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`,
`Permissions-Policy` restrictiva, COOP/CORP `same-origin`, `X-Robots-Tag: noindex`; se elimina el
`Access-Control-Allow-Origin: *` por defecto de Pages. HTML y service worker `no-cache`; `/assets/*` inmutables;
sin source maps ni secretos en el bundle (`scan_secrets.mjs`). Verificable desde fuera con
`scripts/staging/verify_staging.py` (33 comprobaciones; 30 PASS en local y 3 de TLS que solo aplican en remoto).

**Límites de tasa**: el código no lee cabeceras de IP. La limitación por IP en el borde solo puede ser una regla
WAF de zona de Cloudflare (requiere un subdominio propio: decisión de DNS pendiente, BLOCKED). Propuesta:
`/gateway/*` 60 peticiones/10 s y `/gateway/kiosk/authenticate` 20/10 s por IP, sin reglas que reintenten,
reescriban o cacheen (la idempotencia es del servidor y un reintento con el mismo `request_id` es legítimo).
Floods directos contra `*.supabase.co` (PostgREST/Auth) no pueden pasar por el borde propio: los absorbe la
plataforma; medido en local, 504–574 llamadas inválidas de telemetría (310–435/s) rechazadas sin escribir y sin errores
en los fichajes concurrentes (`h7_load.py`).

**Secretos y mínimo privilegio**: tabla de secretos, stores y rotación en `docs/STAGING.md` §2; ninguno en Git,
GitHub Actions/Secrets, `VITE_*`, artefactos ni logs; distintos por entorno. Escáneres ampliados (nombres de
variables H7, tokens de plataforma). Login del gateway solo con `fichaje_gateway`; login de backup de solo
lectura (`pg_read_all_data`, `BYPASSRLS`, `default_transaction_read_only`, TLS obligatorio en `pg_hba`);
token de Cloudflare limitado a Pages Edit de una cuenta; token de tickets fine-grained (Issues de un repositorio
privado). Storage privado, enlaces firmados ≤ 300 s y sin listado anónimo (comprobado por el verificador).

**Revisión de dependencias (2026-09-28)**: `npm audit` sin vulnerabilidades en la raíz (230 paquetes) ni en
`edge/` (91, wrangler 4.142.0); imports npm de las funciones Deno (`postgres@3.4.8`, `hash-wasm@4.12.0`) sin
avisos. `pip-audit` detectó avisos en los pines de Python usados por CI y por las herramientas de operación:
`cryptography 46.0.3` (13, incluido el OpenSSL empaquetado; lo usa el canary en el host de operación) y
`pypdf 6.1.0` (75, DoS con PDF manipulados; solo pruebas). Actualizados a `cryptography 50.0.1` y `pypdf 6.19.0`
(sin avisos) en todos los workflows; regresión completa ejecutada con esas versiones.

**Pendiente en staging (BLOCKED)**: peer TCP real, WAF/DNS, TLS y HSTS reales, pruebas cross-tenant contra el
proyecto remoto (verificador + canary sintético) y revisión de seguridad independiente.
