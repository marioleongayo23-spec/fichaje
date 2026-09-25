# H6 — interfaz y PWA (decisiones y límites)
Revisado 2026-09-25. Documento técnico: describe decisiones de producto/implementación de H6,
no requisitos legales. Único cambio backend: KIO-H6-01 (identificación de kiosco), autorizado
expresamente el 2026-09-25; el resto de H1-H5 (RLS, RPC, motor, auditoría) no cambia.

## Alcance entregado
React + TypeScript + Vite, sin framework adicional ni router externo. Español, mobile-first.
- **Sesión**: login email/contraseña de Supabase Auth, sin registro público; restauración de sesión
  por Supabase Auth (clave `fichaje-auth`); cierre de sesión local que borra la sesión guardada
  aunque no haya red. Un 401 cierra sesión; un 403 revalida membresías y, si el tenant ya no es
  accesible, descarta su estado y lo explica.
- **Multiempresa**: selector explícito cuando la identidad tiene varias membresías activas; con una
  sola se selecciona sola. La selección solo vive en memoria; el árbol de la organización se monta
  con `key` de tenant, así que cambiar de organización descarta todo estado dependiente. Todas las
  consultas filtran además por `organization_id` (RLS sigue siendo la autoridad).
- **Empleado**: fichar (estado, hora informativa del dispositivo, última acción confirmada, solo las
  acciones de su estado), «Mi registro» (`get_own_evidence`: originales, correcciones aprobadas,
  sesiones abiertas como incidencia y totales informativos bruto/pausa/neta/computable), «Mis
  correcciones» (ADD/REPLACE/VOID y «jornada que falta» con revisión previa y motivo obligatorio) y
  «Exportar mi registro».
- **OWNER/ADMIN**: empleados (con y sin cuenta, activar/desactivar, horario, estado, evidencia y PIN
  de kiosco), personas y roles (invitación, rol, retirada de acceso, transferencia de propiedad),
  horarios versionados, bandeja de correcciones, clasificación de horas, exportaciones con entrega
  controlada y kioscos (preparar/revocar).
- **Kiosco** (`/kiosco`): configuración del dispositivo con su identidad técnica; código → PIN →
  estado autoritativo y solo las acciones legales → confirmación tras ACK; sin directorio, navegación
  ni exportaciones; código/PIN borrados al enviarse y pantalla limpia antes de 15 s (14 s sin
  interacción; recibo a los 10 s).

## Confirmación de fichaje (regla absoluta)
Nada se confirma hasta el ACK de `record_time_event` o de `kiosk/record` (recibo tras COMMIT): acción, hora del servidor
(`server_at`, con segundos y zona) y estado resultante. Mientras tanto solo «Enviando…».
- Sin respuesta, timeout o 5xx: **resultado desconocido**. «Comprobar resultado» reenvía la misma
  petición con el mismo `request_id` y `expected_version`: el servidor devuelve el mismo recibo si
  ya se registró o lo registra una única vez. «Consultar solo mi estado» relee el servidor.
- Rechazos del servidor (VERSION_CONFLICT, INVALID_TRANSITION, POLICY_REQUIRED, CLOCK_REGRESSION,
  FORBIDDEN…) se explican en lenguaje llano y se relee el estado. Nunca se muestra SQL, pila ni UUID.
- Doble clic: guarda síncrona en la UI; la idempotencia del servidor sigue siendo la garantía.
- Nunca se usa la hora del navegador como hora efectiva; en correcciones la hora propuesta se
  convierte con la zona IANA de la sesión y se rechazan horas inexistentes (cambio de hora) o se
  pide elegir entre las dos repetidas.

## Offline (PWA-01) y caché (PWA-02)
- Sin conexión: aviso persistente, acciones de fichaje retiradas y explicación del procedimiento de
  contingencia y la corrección posterior. No hay cola, Background Sync ni reproducción de clics.
  Al volver la red se relee el estado del servidor antes de ofrecer acciones.
- Service worker propio (`src/pwa/sw.ts`), sin librerías: precarga exclusivamente la lista del build
  (`/`, JS/CSS con hash, manifest e iconos) inyectada por un plugin de Vite; navegación red-primero
  con el shell en caché como respaldo; nunca gestiona peticiones no-GET, de otro origen, con
  `Authorization`/`apikey`, con query ni rutas `/rest`, `/auth`, `/storage`, `/functions`,
  `/gateway`. Las respuestas de red no se guardan.
- Almacenamiento del navegador: solo la sesión de Supabase Auth (humana o de dispositivo, claves
  separadas) y los identificadores públicos del kiosco. Ningún registro laboral, recibo, exportación,
  URL firmada, PIN, código de kiosco ni credencial tecleada. Nada en sessionStorage/IndexedDB.
- CSP estricta en el build (`script-src 'self'`, `style-src 'self'`, `connect-src` solo propio
  origen y Supabase, `object-src 'none'`), sin estilos ni scripts en línea. `referrer: no-referrer`.

## Decisiones derivadas de los contratos existentes
- **Personas sin email visible**: los contratos no exponen el correo de las membresías; se muestran
  por su ficha de empleado vinculada o como «Persona sin ficha de empleado».
- **Invitaciones**: el token (32 bytes) se genera en el navegador y solo su SHA-256 llega a
  `create_invitation`. El código `organización.token` se muestra una vez para entrega fuera de banda;
  nunca va en una URL. Aceptarlo requiere una cuenta Auth ya existente y verificada con ese correo.
- **Entregas cifradas H4** (credencial de dispositivo y PIN): par RSA-OAEP-256 generado en memoria con
  clave privada no extraíble; se descifra, se muestra una vez y se descarta al cerrar el diálogo. Un
  reintento reutiliza `request_id` y clave pública, por lo que el gateway devuelve el mismo sobre.
- **Listado de kioscos**: no existe RPC de listado. OWNER/ADMIN leen el `audit_log` de su tenant por
  RLS (política `audit_read` existente) y la UI usa solo las acciones `kiosk_provision`/`kiosk_revoke`.
  No muestra nombre ni caducidad (no están en el audit).
- **Clasificación**: el tiempo computable se precalcula replicando `private.computable_month`
  (microsegundos, redondeo único); es informativo. El gestor declara complementarias y extraordinarias
  y las ordinarias son el resto; el servidor recalcula y rechaza cualquier discrepancia.
- **Exportaciones**: no hay RPC de estado de trabajo. La UI conserva en memoria los trabajos de la
  sesión y pide un enlace firmado nuevo en cada «Descargar»; si el firmador lo deniega, informa de que
  puede no estar listo, haber caducado o no estar autorizado (no se distingue FAILED). La generación
  la hace el proceso offline de H5.
- **Independencia**: la bandeja explica cuándo quien mira es solicitante o afectado; el resto de
  negativas (p. ej. haber fichado en nombre del empleado) las decide el servidor y se muestran tal cual.

## Despliegue (pendiente H7)
El gateway de kiosco y el firmador de exportaciones no aceptan CORS abierto. La UI los llama por rutas
del mismo origen (`VITE_KIOSK_GATEWAY_URL`, `VITE_EXPORT_LINK_URL`, por defecto `/gateway/...`). En
pruebas las sirve el proxy de `vite preview`. En producción hará falta un proxy inverso del mismo
origen o una lista de orígenes explícita en esas funciones (cambio backend que requiere aprobación).
Tras un proxy, SEC-H4-01 agrupa los intentos por la dirección del proxy: revisar antes del piloto.

## KIO-H6-01 — identificación de kiosco (resuelto en H6)
**Problema** (detectado al iniciar H6): `/authenticate` exigía `action` y `expected_version` antes de
verificar el PIN y ningún endpoint accesible al kiosco devolvía estado ni versión, así que el kiosco no
podía mostrar las acciones permitidas. **Autorización**: el 2026-09-25 se autorizó corregirlo con un
contrato cerrado. **Contrato implementado** (`20260925000100_kiosk_identification.sql`, gateway Deno):
- `/authenticate` recibe solo `organization_id`, `device_id`, `code`, `pin`. Cualquier campo antiguo
  (`action`, `expected_version`, `request_id`, `employee_id`) se rechaza con el error genérico.
- Tras el PIN correcto el servidor obtiene internamente empleado, estado (OUT/WORKING/PAUSED) y versión y
  devuelve únicamente `state`, `version`, `actions` y un challenge por acción legal
  (`{action, challenge, request_id}`): OUT→CLOCK_IN; WORKING→BREAK_START+CLOCK_OUT;
  PAUSED→BREAK_END+CLOCK_OUT. Nunca devuelve el identificador, código ni nombre del empleado.
- Cada challenge queda ligado en servidor a organización, dispositivo, empleado, acción,
  `expected_version`, su propio `request_id`, versión de credencial y TTL ≤ 60 s; no hay challenge
  genérico. Los hermanos comparten `grant_id`: ejecutar uno los consume todos, así que el segundo no
  puede generar evento (403); dos grants distintos sobre la misma versión acaban en VERSION_CONFLICT.
- `/record` ya no acepta `employee_id`: el challenge identifica al empleado. Se mantienen Argon2id,
  pepper, límites 5 empleado / 30 dispositivo / 60 red, IP minimizada (HMAC), errores genéricos,
  suelo de 300 ms, `no-store`, hashes de challenge, idempotencia, revocación, recuperación de ACK,
  máquina H2 y RLS/FORCE RLS. El dispositivo sigue sin acceso libre a estado, eventos, directorio,
  historial ni RPC humanas.
- UI: el adaptador `HttpKioskGateway` valida estrictamente la respuesta (forma desconocida = fallo de
  identificación) y el terminal muestra solo las acciones ofrecidas por el servidor. Tras un resultado
  desconocido, «Comprobar» reenvía la misma tupla; si entonces el servidor la rechaza, la UI no afirma
  que no se registró: pide volver a identificarse para ver el estado real.

## Pruebas
- Unitarias/componentes (Vitest, `npm test`): tiempo/DST, totales y paridad con `computable_month`,
  constructor de correcciones, errores, códigos, configuración/CSP, política del service worker,
  terminal de kiosco y adaptador KIO-H6-01 (parser estricto y cuerpos exactos enviados), guardas de
  código fuente, workflows y escáner de secretos.
- Navegador real (Playwright, `npm run test:e2e`; requiere Supabase local reconstruido con
  `supabase db reset --local --no-seed` y `python3 tests/integration/journal_init.py`, Deno y Python): 45 pruebas
  en Chromium escritorio y móvil contra Auth/PostgREST/Storage/PostgreSQL reales, gateway H4 y
  firmador H5 reales. Sin trazas, vídeos ni capturas. `scripts/scan_secrets.mjs` revisa `dist` y
  `test-results`.
