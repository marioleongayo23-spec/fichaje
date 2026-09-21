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
separado con SELECT solo memberships para evitar recursión. Objetos schema-qualified, search_path='',
sin SQL dinámico, auth.uid no NULL, argumentos/longitudes validados. Revocar EXECUTE de PUBLIC/anon.
No permitir al rol técnico cambiar roles, desactivar triggers o concederse permisos.
Revalidar organización/membresía/empleado en transacción; expected_version y FK compuestas.
No confiar en JWT user_metadata ni organization_id recibido sin comprobación.
Toda alta, baja, invitación y cambio de rol es idempotente, auditado y mantiene un OWNER activo.
Alta de la primera organización por flujo controlado servidor; no signup público autootorgado.

## Kiosco sin email (H4)
OWNER/ADMIN provisiona dispositivo: identidad Auth técnica única, sin memberships; token renovable
solo en dispositivo autorizado y revocable. Gateway valida JWT, device_id activo, tenant y caducidad.
Empleado introduce código + PIN mínimo 8 dígitos generado aleatoriamente; nunca listado de empleados.
PIN hash Argon2id (mínimo 19 MiB, t=2, p=1, recalibrar) con salt por credencial y pepper en secret store.
Rate limit persistente: 5 intentos fallidos/empleado/15 min y 30/dispositivo/15 min; IP de forma
minimizada como defensa adicional, nunca prueba de identidad. Respuesta genérica y tiempo uniforme.
Reset por gestor auditado, revoca credencial anterior; no recuperar PIN original ni registrarlo.
Tras validación, gateway crea challenge 256 bits, hash almacenado, TTL 60 s, ligado a tenant,
empleado, dispositivo, acción, expected_version y request_id. RPC solo para rol backend dedicado
(no usar service_role como acceso universal habitual); consume challenge y ficha en la misma transacción.
Reintento mismo request_id devuelve recibo previo tras reautenticar dispositivo/empleado;
no consume de nuevo challenge ni permite cambiar payload. Revocación gana si obtiene lock primero.
Kiosco sin consultas libres, exports ni roles administrativos; limpia PIN/recibo a los 15 s, no persistir
credenciales de empleado. Solicitudes de corrección asistidas autentican empleado del mismo modo.
PIN reduce fricción pero no prueba presencia física ni evita que se comparta; empresa debe aceptar
riesgo y procedimiento antes del piloto. Sin conexión no confirmar fichaje.

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
