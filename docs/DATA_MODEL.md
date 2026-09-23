# Modelo PostgreSQL — contrato por hitos
H1 implementa identidad, empleados, invitaciones y soporte de auditoría/idempotencia: ver
`supabase/README.md` y `supabase/migrations/20260921000100_identity.sql`. El resto sigue previsto
para H2-H5. No hay proyección employee_state ni eventos en H1.
Membresías y empleados añaden `version bigint >= 1` para concurrencia optimista.
## Convenciones y constraints
UUID PK mediante gen_random_uuid(); organization_id UUID NOT NULL en toda fila tenant.
Cada tabla referenciable tiene UNIQUE(organization_id,id); FK tenant compuestas y ON DELETE RESTRICT.
Todas las fechas de creación autoritativas son timestamptz NOT NULL de servidor.
No usar cascadas para borrar registros. Índices RLS por organization_id, auth_user_id, employee_id.
Enums: role OWNER/ADMIN/EMPLOYEE; state OUT/WORKING/PAUSED; event_type según MASTER_SPEC.
JSONB acotado y validado por RPC; no metadatos arbitrarios de cliente ni datos clínicos en motivos.

| Tabla / esquema | Columnas principales y restricciones |
|---|---|
| public.organizations | id PK (tenant raíz), name, status ACTIVE/SUSPENDED, created_at; id es el ámbito RLS |
| public.memberships | id, organization_id, auth_user_id FK auth.users RESTRICT, role, active, created_at; UNIQUE(org,auth_user_id) |
| public.employees | id, organization_id, code, display_name, membership_id nullable, active, created_at; UNIQUE(org,code), UNIQUE(org,membership_id); FK compuesta membresía |
| public.work_policies | id, organization_id, version, timezone IANA validada, break_counts_as_work boolean, valid_from, created_by, created_at; UNIQUE(org,version); append-only |
| public.employee_policy_assignments | id, organization_id, employee_id, policy_id, effective_from, created_by, created_at; append-only, sin vigencias ambiguas; selección bajo lock empleado |
| private.employee_state | organization_id, employee_id PK compuesto, state, open_session_id nullable, version bigint >=0, last_sequence bigint >=0, last_event_at; proyección mutable reconstruible |
| public.work_sessions | id, organization_id, employee_id, policy_id, timezone, created_at; inmutable; fin derivado de eventos, FK compuestas |
| public.time_events | id, organization_id, employee_id, session_id, sequence bigint, event_type, server_at, actor_membership_id nullable, kiosk_device_id nullable, source WEB/KIOSK, request_id; UNIQUE(org,employee_id,sequence); actor conforme a source |
| public.correction_requests | id, organization_id, employee_id, submitted_by_membership_id nullable, submitted_via_device_id nullable, base_version, reason 1..1000 chars, proposal JSONB <=64KB, created_at; append-only, identidad de solicitante validada |
| public.correction_decisions | id, organization_id, request_id, decision APPROVE/REJECT, actor_membership_id, reason, created_at; UNIQUE(org,request_id), append-only |
| public.event_adjustments | id, organization_id, employee_id, decision_id, target_event_id nullable, supersedes_adjustment_id nullable, operation ADD/REPLACE/VOID, effective_at nullable, event_type nullable, session_id, ordinal, created_at; append-only |
| public.hour_classifications | id, organization_id, employee_id, local_month, previous_id nullable, regular_seconds, complementary_seconds, overtime_seconds >=0, basis_version, reason, actor_membership_id, created_at; append-only; sum validada contra horas computables; no nómina |
| private.idempotency_records | organization_id, principal_kind USER/KIOSK, principal_id, operation, key UUID, payload_sha256, response JSONB, created_at; PK(org,principal_kind,principal_id,operation,key) |
| private.kiosk_devices | id, organization_id, auth_user_id UNIQUE FK Auth (cuenta técnica), name, active, expires_at, created_at; sin membership humana |
| private.kiosk_credentials | organization_id, employee_id PK compuesto, pin_hash, credential_version, failed_attempts, locked_until, changed_at; nunca accesible por PostgREST |
| private.kiosk_challenges | id, organization_id, device_id, employee_id, action, expected_version, request_id, token_hash, expires_at, used_at; token un uso atómico, TTL 60 s |
| private.auth_attempt_buckets | organization_id, device_id, subject_hash, window_start, failures, locked_until; PK(org,device_id,subject_hash,window_start); actualización atómica |
| public.audit_log | id, organization_id, actor_kind USER/KIOSK/SYSTEM, actor_id, employee_id nullable, action, entity_type, entity_id, request_id, server_at, safe_details JSONB; append-only |
| private.export_jobs | id, organization_id, employee_id nullable, requested_by, filters, cutoff_at, status, schema_version, checksum, object_path, expires_at; acceso RPC; snapshot de resultados privado |
| private.legal_holds | id, organization_id, employee_id nullable, scope, reason, authorized_by, created_at, release_of nullable; imposición/liberación append-only |
| private.retention_runs | id, organization_id, cutoff, authorization_ref, counts, digest, created_at; manifiesto de purga sin contenido personal |

En filas tenant, `org` en UNIQUE abrevia organization_id. Campos FK de actor/empleado/sesión/política
usan siempre tenant compuesto, incluidos target_event, supersedes y previous_id.
Un auth_user_id puede existir en múltiples tenants; identidad Auth no se elimina hasta resolver
referencias legales. Al baja se revocan sesiones y se desactiva membresía, no se purga auditoría.
Estado OUT implica open_session_id NULL; WORKING/PAUSED exige sesión del mismo empleado.
Una única fila estado por empleado impide dos sesiones abiertas. Proyección se crea en la misma
transacción de alta. Secuencia jamás reutilizada aunque exista VOID.

## Correcciones y proyección
Solicitud inmutable describe conjunto atómico de ADD/REPLACE/VOID, referencias originales,
instantes propuestos UTC y zona/offset de interpretación. ADD requiere session_id (nueva sesión
creada al aprobar si procede), tipo y posición; REPLACE referencia original y ajuste vigente;
VOID referencia original/ajuste vigente y no borra. Una segunda corrección referencia la revisión previa.
Decisión única por solicitud; base_version desfasada se rechaza como conflicto y exige nueva solicitud.
Rechazar no crea ajustes. Aprobar bloquea estado, exige gestor distinto del empleado afectado y
solicitante, valida motivo y replay completo del timeline efectivo del empleado (incluidos límites
adyacentes y sesión abierta). No intervalos negativos, solapados, transiciones imposibles ni tiempos
futuros respecto al reloj servidor. Empates requieren ordinal explícito validado, nunca orden UUID.
Corrección incrementa versión del empleado, inserta ajustes, decisión, auditoría e idempotencia
juntos y reconstruye estado. No modifica server_at original; effective_at propuesto queda etiquetado
como corrección. Lecturas históricas permiten reconstruir 'como se conocía' a una fecha de corte.
Asignación/política usada en una sesión se fija al entrar; cambio de política solo para sesiones nuevas.

## Inmutabilidad
Revocar INSERT/UPDATE/DELETE/TRUNCATE al cliente. Escrituras mediante funciones con permisos
mínimos; triggers impiden UPDATE/DELETE en tablas append-only incluso a RPC ordinarias.
Permisos y triggers no protegen de un superusuario: acceso DB excepcional, auditado fuera de DB;
backups y manifiestos externos permiten detectar divergencias. No prometer inviolabilidad criptográfica.
Purga legal solo mediante rol offline distinto sin login expuesto, proceso aprobado y manifiesto;
no una opción de ADMIN/OWNER. Nunca agregar bypass por variable configurable desde cliente.

## Contratos RPC a implementar
Entrada común: organization_id, request_id UUID y expected_version cuando exista agregado.
Identidad humana se obtiene de auth.uid(); ninguna RPC acepta un actor arbitrario como autoridad.

| RPC | Entrada específica | Resultado / autorización |
|---|---|---|
| record_time_event | employee_id, action, expected_version | Recibo descrito en MASTER_SPEC; empleado propio activo |
| submit_correction | employee_id, base_version, reason, operations[] | request_id persistido; propio o gestor; sin cambiar jornada |
| decide_correction | correction_request_id, APPROVE/REJECT, reason | decision_id y nueva versión si aprueba; gestor independiente |
| manage_employee | code, display_name, membership vinculada opcional, active | ID/version; ADMIN/OWNER, nunca cambiar tenant |
| manage_membership | target, role, active | ID/version; OWNER para ADMIN/OWNER; ADMIN solo EMPLOYEE |
| transfer_ownership | nuevo_owner_membership_id | Cambio atómico de roles y audit, solo OWNER |
| get_own_evidence | rango acotado, cursor | Evidencia filtrada del empleado propio |
| request_export | rango, employee_id opcional, formato | job_id; propio o gestores del tenant |
| kiosk_record_event | challenge y request_id | Recibo mínimo; solo gateway autenticado con rol dedicado |

H1 implementa invitaciones de un solo uso: token hash privado, tenant/rol/email destino ligados,
TTL 24 h, aceptación por identidad verificada, sin autoasignar rol desde signup. No crea employees
sin consentimiento administrativo; provisioning de kiosco separado. H0 no invita ni crea cuentas.
Errores estables: UNAUTHENTICATED, FORBIDDEN (sin revelar existencia ajena), INVALID_INPUT,
INVALID_TRANSITION, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, CLOCK_REGRESSION, RETRYABLE_TIMEOUT.
Errores validación no consumen clave; éxito persiste respuesta. No devolver SQL, PIN ni JWT.

## H3 implementado — detalles del contrato de transporte
Ver `supabase/README.md` para JSON y errores estables. `correction_decisions` incluye
employee_id y FK compuesta a solicitud; ajustes enlazan decisión, evento, sesión y ajuste
previo mediante `(organization_id,employee_id,id)`. Un único sucesor por ajuste y una sola
primera revisión por original impiden bifurcaciones. La cadena de ADD tiene target NULL;
la de original conserva target. Cada hoja no VOID participa en el timeline efectivo.
Ordinal positivo explícito en ADD/REPLACE; originales usan sequence. Corte histórico por
server_at original/created_at del ajuste. Se conserva la evidencia de autor y fuente.
La proyección separa last_sequence original de last_event_at efectivo, permitiendo historia
completamente anulada o formada solo por ADD. Se preserva el contrato de independencia;
hour_classifications no es necesario para correcciones y no se implementa en H3.

`correction_requests.affected_membership_id` conserva el vínculo al presentar la solicitud
(FK tenant, nullable sin Auth). La independencia considera vínculo actual, vínculo
capturado, solicitante y autor de originales; una reasignación no borra esta evidencia.
