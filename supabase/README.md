# H1 — Supabase local

Requisitos: Docker, Supabase CLI **2.117.0**, Python 3.12+, Node 24 para H0.
Sin proyecto remoto, secrets de GitHub ni datos reales.

```sh
supabase start -x realtime,imgproxy,edge-runtime,logflare,vector,supavisor
supabase db reset --local --no-seed
supabase test db
python3 tests/integration/h1.py
supabase stop --no-backup
```

`db reset` destruye solo esta base **local**, reaplica migraciones desde vacío, sin seed.
Los tests de integración comprueban que API_URL sea loopback, crean cuentas sintéticas
con GoTrue y usan JWT emitidos por Auth contra PostgREST y Storage reales. Las claves locales
se leen en memoria mediante `supabase status -o json`; no se imprimen ni se guardan.
SQL/pgTAP comprueba privilegios, RLS/FORCE RLS, roles técnicos, dos tenants × tres roles,
FK, UUID/join/RPC cruzados, OWNER mínimo y revocación. No hay mocks JavaScript.
GitHub Actions `Database H1` ejecuta el mismo procedimiento desde runner nuevo y destruye
los contenedores al terminar. Un check pendiente/fallido bloquea H1.

## Contrato implementado

- `organizations`, `memberships`, `employees`; vínculo empleado→membresía nullable,
  ninguna columna email obligatoria para empleados, unicidad por tenant y FK compuestas.
- Lectura autenticada por RLS, sin DML directo; anon sin acceso. Storage sin políticas de
  negocio ni buckets de producción: se prueba denegación sobre un objeto privado sintético.
- `manage_employee`: UUID elegido por cliente, versión 0 para alta, versión actual para edición.
  OWNER/ADMIN; membresía opcional, activa y del mismo tenant. No mueve empleados entre tenants.
- `manage_membership`: modifica una membresía existente; ADMIN solo EMPLOYEE, OWNER también ADMIN.
  Nunca crea OWNER. Baja lógica conserva empleados e historia. Crear acceso requiere invitación.
- `transfer_ownership`: OWNER entrega a otro miembro activo, pasa a ADMIN; roles cambian juntos.
- Todas las mutaciones H1: request UUID obligatorio, payload ligado a clave, auditoría y recibo
  transaccionales, bloqueo de organización, autorización tras lock y antes de replay.
  Versionado optimista en empleados/membresías. Una transferencia previa puede repetirse
  por el antiguo OWNER aún activo como ADMIN; no puede iniciar otra.
- Alta inicial: `private.bootstrap_organization(org_uuid,name,verified_auth_uuid,request_uuid)`
  solo operador PostgreSQL; NO grant al cliente/service_role, NO signup trigger. Requiere
  Auth verificado preexistente. Idempotente, auditada, mínimo OWNER validado al commit.
- Invitación: gestor genera token aleatorio de 32 bytes/64 caracteres hex; pasa solo SHA-256
  a `create_invitation`. `accept_invitation` recibe token, ligado a tenant/email verificado/rol,
  TTL 24 h, un uso, revalidación del emisor. No reactiva membresías revocadas. Sin envío email
  ni interfaz en H1; entrega del token fuera de banda. Tokens no se guardan en claro.
- Baja de membresía: incluso JWT aún válido pierde inmediatamente acceso al tenant (incluye
  replay). No se elimina Auth ni se hace logout global: una identidad puede pertenecer a otras
  empresas. Revocación global de sesiones Auth queda en procedimiento operativo futuro.

## Seguridad y límites

`fichaje_reader` y `fichaje_writer` son NOLOGIN, NOSUPERUSER, NOBYPASSRLS, sin miembros cliente.
El lector solo consulta organizaciones y membresías; el helper obtiene exclusivamente auth.uid().
Supabase protege el esquema Auth y su RLS. Dos adaptadores escalares privados propiedad de
postgres forman el puente de lectura: `request_uid()` devuelve solo auth.uid();
`verified_auth_email(uuid)` devuelve solo el email de una identidad verificada/no bloqueada,
y solo el escritor puede ejecutarlo. Ninguno lee ni modifica datos tenant. No se concede a
roles técnicos acceso directo a auth.users ni herencia de authenticated/service_role.
El escritor tiene políticas internas y permisos acotados; RPC SECURITY DEFINER con search_path
vacío valida toda autoridad. Esos roles no tienen CREATE en schemas ni gestión de roles.
`private` no está expuesto por API ni tiene USAGE cliente; helpers autorizados se usan en RLS.
Auditoría y recibos append-only; un administrador PostgreSQL sigue siendo privilegiado.
La auditoría H1 registra actor, acción, entidad, request, instante y before/after de seguridad, nunca token/email/payload.
No se implementan proyección horaria, eventos, correcciones, kiosco, exportación ni UI.

Referencias de comandos: [Supabase CLI](https://supabase.com/docs/reference/cli/introduction),
[pruebas SQL](https://supabase.com/docs/guides/database/testing).

## Correcciones de revisión H1

SEC-H1-01 y AUD-H1-01 se aplican en la segunda migración. Ver detalles en `docs/SECURITY.md`.
El escritor ordinario tiene contexto de tenant protegido por transacción; bootstrap y aceptación
usan roles separados. El guard no escribe tablas tenant. Un GUC no puede autorizar un tenant.
La suite `h1_findings.test.sql` ejercita el escritor directamente y una función defectuosa sin
filtro, además de reconstruir role/active/vínculo y OWNER solo desde audit. La suite SQL anterior
borra contexto exclusivamente como postgres al cambiar identidades simuladas dentro de su única
transacción de test; esa facultad no está concedida al escritor ni a clientes.
La integración real mantiene una transacción por request y verifica de nuevo la reconstrucción
usando el endpoint REST de audit. El comando reproducible sigue siendo `supabase db reset
--local --no-seed`, `supabase test db` y `python3 tests/integration/h1.py`.

## H2 — motor horario

`python3 tests/integration/h2.py` ejecuta H1 completo y después H2. CI conserva
`supabase db reset --local --no-seed` + `supabase test db` antes de la integración.
No hay mocks de SQL/RLS. Fechas históricas DST se insertan como fixtures privilegiadas
revertidas al acabar pgTAP; el guard real valida igualdad. La regresión se prueba
contra la RPC sin modificar el reloj, adelantando solo la proyección de test.
El timeout tras commit usa un proxy local que pierde el ACK de PostgREST real.

RPC nuevas (todas con prefijo `p_` en argumentos):
- `create_work_policy(organization_id, request_id, timezone, break_counts_as_work)`:
  OWNER/ADMIN; versión secuencial por tenant, vigente desde servidor; IANA validada.
- `assign_work_policy(organization_id, request_id, employee_id, policy_id,
  effective_from = null)`: OWNER/ADMIN; null = ahora servidor, sin retroactividad;
  no admite dos asignaciones en el mismo instante. Gana la última vigente al entrar.
- `record_time_event(organization_id, request_id, employee_id, action, expected_version)`:
  solo empleado propio activo (también para gestores). Versión inicial 0; no acepta
  hora ni actor ni sesión cliente. Recibo con event_id/session_id/server_at/state/
  version/sequence/request_id. Debe recibirse ACK para confirmar; timeout = desconocido.
- `get_employee_state(organization_id, employee_id)`: propio o gestor; devuelve versión,
  secuencia, sesión abierta y `OPEN_SESSION` mientras esté incompleta. No calcula horas.

Orden de locks: autorización/contexto y organización H1 → employee_state FOR UPDATE.
La serialización por tenant también ordena idempotencia entre empleados y revocaciones.
Es conservadora: empleados distintos del mismo tenant esperan entre sí; optimización
solo con evidencia futura. Nueva alta crea proyección con trigger invoker; backfill OUT
para empleados H1. El estado se preserva al editar/desactivar el empleado.
Las RPC H1, sus privilegios y sus capabilities no se sustituyen ni amplían.

Sesión y política permanecen fijas al entrar; salida pausada no inserta BREAK_END.
Secuencia/versión avanzan una unidad por evento. Se permite igualdad de instantes.
CLOCK_REGRESSION rechaza sin escrituras, visible como error operativo a quien llama;
una alerta externa persistente queda pendiente de observabilidad del piloto H7.
UTC para intervalos, zona IANA fijada para día local de entrada. No hay cierres
por medianoche/duración, ni totales inventados, ni informes H5 anticipados.
