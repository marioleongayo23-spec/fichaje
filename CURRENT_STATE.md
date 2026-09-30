# CURRENT_STATE — 2026-09-30
## HITO 7 — frontend desplegado y Fichaje Demo creada desde la app (2026-09-30)

**BLOCKED para cerrar H7: validación de producto incompleta.** Esta nota sustituye el bloqueo anterior del despliegue. Antes de tocar staging se comprobaron los cinco workflows del HEAD `70143ddcb0d301dbc127c0391a083d36145c80b7`, todos completed/success: CI [36683622732](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36683622732), Database [36683622744](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36683622744), E2E [36683622706](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36683622706), OPS-02 [36683622678](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36683622678) y H7 [36683622681](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36683622681). E2E conserva 50/50 PASS. El commit de esta evidencia vuelve a ejecutar los cinco gates; no se afirma su resultado antes de completarse.

El usuario autorizó expresamente la alternativa oficial de CLI tras persistir la verificación humana del dashboard Cloudflare y completó el device login. Wrangler fijado por el repo desplegó el frontend y Pages Functions del SHA anterior en el proyecto existente `fichaje-staging`, conservando bindings/secrets. Deployment `cd8fb8b1`; URL estable verificada en Cloud Browser: https://fichaje-staging.pages.dev/. El alias de Pages corresponde exclusivamente al proyecto staging; no se desplegó Fichaje APP/producción. Build PASS; scan requerido de dist: 11 archivos, 0 findings. Lectura HTTP posterior: portada 200 con CSP/HSTS, Auth signup=true/confirmación obligatoria/anonymous=false; readiness export-link 200 UP y kiosco 200 DEGRADED (auth UP, database DEGRADED), repetido una vez para leer el detalle. No se afirma readiness de kiosco UP; las escrituras del ciclo sí están verificadas en PostgreSQL. Credencial CLI solo local privada 0600; logging posterior dirigido a /dev/null. El log inicial no contenía patrones de credenciales y se retiró.

**Onboarding remoto real, desde la UI:** Dar de alta una empresa → registro sintético → regreso al login con campos vacíos y sin sesión principal → confirmación oficial Auth → login explícito → Dar de alta mi empresa → Fichaje Demo. La captura PostgreSQL anterior a confirmar/crear empresa mostró Auth sin confirmar, 0 membresías y 0 Fichaje Demo. La captura posterior mostró email confirmado, exactamente 1 Fichaje Demo y exactamente 1 membresía OWNER para el usuario. Identificador de organización: `fb9c2b0e-f71d-4bb4-a6aa-44ea110e56eb`. Solo se creó mediante create_organization de la app; no se escribió manualmente auth.users ni se concedió tenant/rol mediante trigger Auth.

Confirmación sintética segura: los dominios example fueron rechazados por Auth sin crear identidades y el SMTP por defecto no sirve para buzones ficticios. Se utilizó temporalmente un Send Email hook PostgreSQL, SECURITY INVOKER, en esquema no expuesto con RLS/FORCE, sin acceso anon/authenticated/service_role, limitado exactamente a los tres emails ficticios previstos bajo fichaje-staging.pages.dev. Recibió los token_hash generados por Auth únicamente para signup, sin modificar identidades o membresías. El endpoint oficial /auth/v1/verify confirmó OWNER y ADMIN; sesiones de respuesta descartadas, login explícito posterior desde UI. Tokens en archivo temporal 0600 retirado, sin impresión ni GitHub. **Hook desactivado y eliminado; función, tabla y esquema temporal eliminados y ausencia verificada.** Confirm email permanece obligatorio; se restaura el envío normal. Esta prueba no acredita entrega SMTP a clientes reales.

**Preparación de empresa íntegramente desde la app:** OWNER generó invitaciones ADMIN y EMPLOYEE; ADMIN creó su identidad inicialmente sin membresías, confirmó email, inició sesión y aceptó el código de invitación en la UI. La cabecera mostró Administrador. Se crearon fichas Owner Demo, Admin Demo y Persona Demo sin email (esta última sin cuenta Auth ni membresía); horario v1 Europe/Madrid, pausas no computables, asignado a las tres fichas. Se provisionó Kiosco Fichaje Demo y se generó PIN mediante el gateway y entrega cifrada de la UI; código y PIN solo en memoria, sin artefactos. El terminal /kiosco se configuró con sesión técnica separada. La cuenta EMPLOYEE aún no existe: Auth devolvió 429 `over_email_send_rate_limit` al signup por UI (07:56 UTC en logs); no se alteró ningún límite, ni se creó una cuenta por API administrativa. Su invitación está pendiente.

**Recorridos remotos probados:** el empleado sin email completó por kiosco CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT, con cuatro originales KIOSK a las 08:01:51, 08:04:26, 08:05:07 y 08:05:37 UTC. Se comprobó limpieza automática de la pantalla. OWNER completó los cuatro eventos WEB a las 08:06:45, 08:07:02, 08:07:14 y 08:07:25 UTC; Mi registro mostró jornada completa y originales. OWNER solicitó REPLACE de la entrada a 10:06 Madrid con motivo sintético; ADMIN independiente aprobó mediante la UI. PostgreSQL mostró 8 originales conservados, 1 solicitud, 1 aprobación y 1 ajuste append-only. No se tocaron originales.

**Backend onboarding y aislamiento remoto:** replay de `69acc305-06b9-4426-a169-1c7516f1af6e` devolvió el mismo organization_id; nuevo request_id para una segunda empresa rechazado con SQLSTATE 42501 FORBIDDEN. Como authenticated con claims del OWNER, SELECT organizations devolvió 1 propia y 0 otros tenants. Estas tres comprobaciones ejecutaron las funciones y RLS reales en PostgreSQL, con SET LOCAL ROLE/claims en transacciones revertidas; no se presentan como pruebas HTTP con JWT. La UI sí utilizó Auth/JWT reales. Se conservaron las organizaciones canary previas. Advisors security: mismos 19 avisos de RPC SECURITY DEFINER intencionales y aviso de password protection del plan; no se amplió acceso ni se cambió plan.

**Bloqueo funcional concreto descubierto:** ADMIN solicitó por la UI la exportación de toda Fichaje Demo para 2026-09-30. Job `199c626e-5993-4dbd-b21a-86714cb3a074` permanece PENDING; Descargar devuelve el mensaje de paquete no disponible. `scripts/export_worker.py` es un worker offline existente que exige credencial PostgreSQL de operador, SET ROLE fichaje_export_worker y Storage key exclusivamente backend. No hay worker ejecutándose configurado en staging ni credencial de operador disponible en este workspace. El signer export-link no genera paquetes. **Descarga/exportación final NO PASS**; no se marcó READY manualmente, no se subió un paquete improvisado y no se saltó el flujo de producto. Se requiere integrar/activar generación segura a coste cero y volver a probar descarga real. Se corrigió en este PR el acceso al formulario de signup para personas invitadas: nuevo botón «Crear cuenta para aceptar una invitación» y texto que explica que una cuenta no concede empresa ni rol. Usa el mismo cliente Auth efímero y exige confirmación. El E2E parametriza ambos puntos de entrada (52 casos desktop/mobile esperados); typecheck completo, build y scan local 0 findings PASS. Inicialmente faltaban dos tsconfig en la materialización local; se recuperaron exactamente de GitHub y el typecheck completo posterior pasó. El HEAD `fa2f518b48f783217e45007faa2e243819284dc7` terminó los cinco workflows completed/success: CI 36689436102, Database 36689436008, E2E 36689435944, OPS-02 36689436166 y H7 36689436099. E2E job 109803398210: 52/52 PASS, incluidos ambos registros desktop/mobile; scan dist/test-results: 15 archivos, 0 findings. Se desplegó entonces ese HEAD en el Pages existente (deployment `7b9acf21`), con release ID del SHA y build/scan local 0 findings. La nueva UI ya está desplegada; su registro sintético remoto sigue pendiente de la cuota Auth. Los cinco gates de este nuevo commit documental se comprueban antes de continuar con mutaciones remotas.

**Pendiente para cerrar:** completar identidad/invitación/ficha EMPLOYEE cuando Auth permita la confirmación sintética; activar la generación real de exportaciones y verificar ZIP CSV/JSON/PDF desde la app, entrega controlada y revisión final. La puerta de backups/restore definitivos, alertas reales, legal/seguridad y producción sigue separada para el primer cliente real. No tercer Supabase, plan Pro, proveedor de pago ni piloto real como condición de esta fase. Misma rama y PR #15 abierto; sin merge, datos reales o coste contratado.

## HITO 7 — onboarding remoto aplicado; despliegue pendiente (2026-09-30)

**BLOCKED para la validación final con Fichaje Demo.** El código `84a778291b988b57728b7e11cbd61366551bd97a` terminó con los cinco workflows en completed/success: CI [36680540596](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36680540596), Database [36680540605](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36680540605), E2E [36680540553](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36680540553), OPS-02 [36680540589](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36680540589) y H7 [36680540561](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36680540561). E2E: **50/50 PASS**, incluido signup desktop/mobile; escaneo dist/test-results: 0 findings. El formulario conserva su referencia DOM antes de esperar Auth; la prueba verifica retorno al login, campos vacíos y ausencia de pageerror. El cliente efímero de signup se conserva.

Solo se modificó el proyecto Supabase existente `fichaje-staging` (`pvfjffeszsedslmwdvgh`, ACTIVE_HEALTHY). Se aplicó el contenido exacto de `20260929000100_self_service_onboarding.sql`. El conector registró inicialmente una versión generada `20260930071552`; se normalizó únicamente esa entrada del historial a `20260929000100` para coincidir con GitHub, sin reaplicar DDL ni modificar datos de producto. Hay 16 migraciones. Verificado: RPC presente, owner `fichaje_bootstrap`, onboarding_requests con RLS/FORCE, EXECUTE authenticated=true, anon=false, service_role=false, cero triggers de usuario sobre auth.users. Una consulta como authenticated sin identidad ve cero organizaciones; create_organization rechaza UNAUTHENTICATED en transacción revertida.

Se recuperó la sesión del dashboard de Supabase mediante el acceso seguro GitHub. Se habilitó exclusivamente Allow new users to sign up manteniendo Confirm email=true, anonymous=false y manual linking=false. El endpoint público real `/auth/v1/settings` confirmó `disable_signup=false`, `mailer_autoconfirm=false`, email=true y anonymous=false. Site URL y única redirección ya apuntan a `https://fichaje-staging.pages.dev`; no se cambiaron. No se modificó auth.users, no se crearon identidades ni membresías en esta sesión y no se expuso service_role.

El dashboard Cloudflare mostró “Performing security verification” / protección contra bots tanto al abrir como tras la única recarga de recuperación. Se registró challenge_loop y no se intentó eludirlo. Tras completar las comprobaciones independientes se solicitó la toma manual del mismo navegador; la revisión automática la rechazó por considerar que superar la verificación antibot requiere autorización específica. No fue un rechazo manual del usuario y no se reintentó ni se usó otra ruta para eludirlo. Esa toma manual queda pendiente de autorización expresa. **No se desplegó** el nuevo frontend. Cloud Browser abrió la URL estable y verificó que todavía muestra la versión anterior: “Tu empresa crea las cuentas; no hay registro público”, sin Dar de alta una empresa. Por ello **no se ha ejecutado** el recorrido remoto de signup → confirmación → login → Fichaje Demo → OWNER, ni sus pruebas remotas de replay/segunda empresa. PostgreSQL confirma 0 organizaciones llamadas exactamente Fichaje Demo y 0 onboarding_requests. No se sustituyó el recorrido UI por bootstrap manual.

Compilación local del frontend de ese SHA con configuración pública del staging y release ID: PASS; scan_secrets sobre dist: 0 findings. Se compiló también la Pages Function exacta con Wrangler fijado por el repo; no se subió. Un escaneo adicional del Worker server-side marcó únicamente el nombre de binding backend (h7-env-name), esperado fuera del bundle público; el gate requerido de dist sí pasó. Advisor security: avisos sobre las 19 RPC SECURITY DEFINER intencionales con roles mínimos/RLS y protección de contraseñas filtradas deshabilitada; no se cambiaron permisos ni se contrató plan. No hay alerta de tabla pública sin RLS. Referencias: [linter RPC](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [protección password](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

**Pendiente:** recuperar acceso Cloudflare y desplegar ese frontend en el Pages existente conservando sus bindings/secrets, después validar y preparar Fichaje Demo íntegramente desde la app (OWNER/ADMIN/EMPLOYEE/sin email/horario/kiosco, fichajes, correcciones y exportación). El commit documental posterior repite los cinco gates; no convierte el bloqueo remoto en PASS. No merge, producción, datos reales, nuevos proyectos ni coste. La puerta previa al primer cliente real permanece separada y no bloquea por infraestructura de pago esta fase sintética.

## HITO 7 — corrección del formulario de registro (2026-09-30)

El HEAD `eb6d9e7151bc6280470d3eafc4f1e4421ce2d1e9` terminó con CI, Database, OPS-02 y H7 PASS; E2E run 36679773856 FAIL, 48/50 PASS. Fallaron solo las pruebas de registro desktop/mobile al esperar el regreso al login. Además del aislamiento Auth ya aplicado, LoginPage usaba `event.currentTarget` después de un await: React limpia esa referencia al terminar el dispatch. Se conserva ahora el formulario antes del await y se resetea mediante esa referencia. Las pruebas existentes comprueban también ausencia de pageerror y campos vacíos tras signup. La regresión del nuevo HEAD está pendiente; no se afirma PASS.

Staging no se ha modificado en esta sesión: migración onboarding, configuración Auth, despliegue y validación de Fichaje Demo desde la app quedan pendientes hasta los cinco workflows PASS. Sin merge, producción, datos reales, infraestructura adicional ni coste.

## Cambio de alcance HITO 7 — validación final con empresa ficticia (2026-09-29)

Por decisión expresa del usuario, **se abandona el piloto con empresas reales y los simulacros remotos separados como condición de cierre de H7**. El objetivo inmediato es terminar la aplicación y validarla de principio a fin en el entorno desplegado utilizando una empresa ficticia y datos exclusivamente sintéticos.

La evidencia remota ya conseguida se conserva: verify_staging.py 33 PASS / 0 FAIL / 0 SKIPPED, web y kiosco sintéticos PASS, SEC-H4-01 remoto verificado e invariantes sin CRITICAL/WARNING. Las suites existentes de fallo/rollback, carga, incidente y REC permanecen en CI/local y no se eliminan.

**Nueva puerta de salida H7:** empresa ficticia estable con OWNER/ADMIN/EMPLOYEE y kiosco sintéticos; recorrido real desde la UI de login, configuración, fichajes/pausas/salida, correcciones, registro e informes/exportación; aislamiento y seguridad ya verificados; workflows del head final en verde; revisión del usuario de la app final. No se requiere tercer Supabase, proveedor de guardia real ni empresa piloto real para cerrar esta fase.

Los requisitos operativos que solo son necesarios antes de aceptar clientes reales —alertas reales, backup/restore en la infraestructura definitiva, respuesta a incidentes, revisión legal/seguridad final y autorización de producción— quedan **diferidos, no eliminados**, a una puerta específica previa al primer cliente real. Política de coste: 0 EUR mientras no sea estrictamente necesario; cualquier gasto requiere autorización expresa. PR #15 continúa abierto y no se hace merge sin orden posterior.

## HITO 7 — gates remotos verificados y cuota de restore (2026-09-29)

**BLOCKED — todavía no READY FOR PILOT.** El head previo `040047c45c12b91c9072281fa981f1b2ab5c8880` tuvo los cinco workflows
CI, Database, E2E, OPS-02 y H7 en `completed/success`. El estado sintético
local del canary conserva modo `0600` y no se ha subido al repositorio.
Los canales web y kiosco, ejecutados por separado contra Supabase y
Cloudflare Pages reales, terminaron **PASS**. Después,
`scripts/staging/verify_staging.py` sobre las URLs remotas, con
`--canary-state` y **sin `--local`**, terminó exit 0: **33 PASS, 0 FAIL,
0 SKIPPED**, incluido el canary web+kiosco, TLS 1.3, CSP/HSTS,
Auth/Storage/API, borde y rechazo de bypass directo. El host de ejecución
necesitó su proxy HTTPS para el socket TLS y un User-Agent identificable
`Fichaje-H7-Monitor/1.0`; se usó un adaptador local sin alterar el script
del repositorio, las reglas de Cloudflare ni los secretos de despliegue.

**SEC-H4-01 real:** tres PIN erróneos desde el host de operaciones dieron
403 y un bucket con tres fallos. Un cuarto desde una función Edge temporal
separada, a través del mismo gateway, dio 403; la consulta posterior a
`private.kiosk_network_buckets` mostró **un bucket, cuatro fallos**.
Por tanto, el identificador de red que ve `kiosk` corresponde al peer TCP
del proxy de Cloudflare y no separa las IP originales de esos dos clientes;
el límite de 60 fallos/15 min protege conservadoramente el tenant completo.
La función `h7-network-origin` y su secreto de prueba se eliminaron; el
inventario volvió a solo `kiosk` y `export-link`. Los intentos fallidos
no generaron fichajes. Hay 21 eventos y 21 auditorías de eventos,
exclusivamente sintéticos, en dos organizaciones y tres empleados.

`private.ops_record_invariant_run()` en staging generó el run
`5a9d6173-baa5-4f8c-a97e-8cd40e03b5aa`: **0 CRITICAL, 0 WARNING**, un
INFO `OPEN_SESSIONS` correspondiente al control sintético; dos baselines,
aún no congeladas. El monitor `health.py` desde este host dio DOWN por
latencia/timeout de su ruta proxy (sin DSN de monitor), aunque readiness de
ambas funciones y el resto del borde pasaron el verificador remoto. No se
afirma OPS-02 operativo ni alertas configuradas.

**Restore:** tras la confirmación expresa del usuario del coste consultado
`amount=0/monthly`, la creación de `fichaje-h7-restore-temp` en
`eu-west-1` fue rechazada por Supabase: el propietario ya tiene dos
proyectos gratuitos activos, su límite global. No se creó el tercero, no se
pausó ni modificó `Fichaje APP`. La tarifa publicada para un tercer proyecto
requiere Pro ($25/mes de organización; compute adicional según proyectos);
se precisa una nueva autorización de facturación para esa tarifa real.
REC-01..03, backup cifrado, custodia age, alertas, fallo inducido/rollback,
carga H7 e incidente remoto permanecen pendientes. Sin producción,
clientes reales, datos laborales reales ni merge. Esta nota prevalece sobre
las notas históricas siguientes.

## HITO 7 — canary sintético remoto parcial (2026-09-29)

**BLOCKED — todavía no READY FOR PILOT.** Los cinco workflows (CI,
Database, E2E, OPS-02, H7) del head `f5e3ee3390c167dd5e0be6b4274c24e34295ccc3`
terminaron success. En el único proyecto de staging existente se crearon
**dos organizaciones, tres usuarios Auth y dos empleados iniciales exclusivamente
sintéticos** (tenant y control). El control conservó un evento `CLOCK_IN`;
el tenant tenía cuatro eventos del primer intento web, con estado final `OUT`.
Se reconstruyó un estado canary local `0600`; las credenciales sintéticas se
rotaron con una función temporal restringida a esos tres identificadores,
y se **eliminó** la función y su secreto de recuperación tras comprobar los
tres cambios. El inventario Edge volvió a mostrar solo `kiosk` y `export-link`.
No se registraron contraseñas, PIN, claves privadas ni secretos en GitHub.

El comando real `scripts/ops/canary.py run --channels web`, contra
`https://pvfjffeszsedslmwdvgh.supabase.co`, terminó con exit 0 e informe
`{"status":"PASS","channels":{"web":{"status":"PASS","rotated":false}}}`.
Verificó el ciclo completo, respuestas, versiones, marcas de tiempo,
aislamiento entre tenants, auditoría y reintentos idempotentes. La URL
`/gateway/kiosk/health/ready` devolvió 200 `UP` desde la shell.

La provisión del kiosco por `/gateway/kiosk/provision` recibió 403; una
petición diagnóstica autenticada desde el mismo cliente devolvió el texto
Cloudflare `error code: 1010`, anterior al gateway. La portada sí dio 200
desde curl y abrió en Cloud Browser. Por tanto, **kiosco y SEC-H4-01 no están
verificados**. Se ejecutó `verify_staging.py` con ambas URLs remotas y
`--canary-state`, **sin `--local`**: abortó antes del informe por
`socket.gaierror: Temporary failure in name resolution` al abrir su socket
TLS directo. No hay resultado de 0 FAIL/0 SKIPPED. No se alteró la protección
de Cloudflare ni se acreditan gates remotos por inferencia.

El conector Supabase `get_cost` para un proyecto adicional en la organización
respondió `amount=0`, recurrencia mensual. **No se ha creado** el proyecto
vacío temporal de restore: falta la confirmación expresa del usuario incluso
con coste indicado de 0/mes. También faltan canary kiosco, SEC-H4-01,
health/invariants/alertas completas, fallo y rollback, carga, incidente,
backup cifrado y REC-01..03. Sin producción, clientes ni datos laborales reales;
PR #15 abierto, sin merge. Las notas anteriores quedan como historial.

## Readiness remoto recuperado — 2026-09-29 (PR #15)

**HITO 7: BLOCKED — todavía no READY FOR PILOT.** Tras el despliegue
normal de `kiosk` con el DSN del pooler, se hizo una única petición
desde una versión diagnóstica temporal de `export-link` a
`https://fichaje-staging.pages.dev/gateway/kiosk/health/ready`.
El log de Supabase Edge registró `H7_GATEWAY_READINESS 200 UP DB_UP`
a las 07:10:27 UTC: readiness real del gateway y base de datos UP.
La llamada directa sin firma a `export-link` siguió en 403. Se retiró
el probe y se redeplegó `export-link` original; `kiosk` permanece
con el código original. No se instaló `pg_net` ni se creó otro proyecto.
No se registraron secretos ni cuerpos en ese diagnóstico.

Los cinco workflows (CI, Database, E2E, OPS-02, H7) del head
`8c12ccde` terminaron **success**. Esta CI sigue validando la forma
local y no sustituye `verify_staging.py` remoto. Permanecen pendientes
canary sintético, SEC-H4-01 real, invariantes/alertas, fallo/rollback,
carga, incidente y backup/restore REC-01..03 remotos. El verificador
requiere un estado canary `0600` para evitar SKIPPED; la provisión
sintética y la ruta de ejecución externa siguen por configurar. Sin
producción, datos reales ni merge.

## Avance del login de kiosk — 2026-09-29 (PR #15)

**HITO 7: BLOCKED — no READY FOR PILOT.** Con la autorización expresa del
usuario se creó **solo en** `fichaje-staging` (`pvfjffeszsedslmwdvgh`)
el login `fichaje_gateway_login`: LOGIN/INHERIT, sin SUPERUSER,
CREATEDB, CREATEROLE, REPLICATION ni BYPASSRLS, con única membresía
`fichaje_gateway`. La contraseña aleatoria se guardó únicamente en
archivo temporal `0600` y `KIOSK_DATABASE_URL` se configuró en Edge Secrets;
no se imprimió ni se guardó en GitHub. El DSN usa el pooler compartido de
sesión (`aws-1-eu-west-1.pooler.supabase.com:5432`), usuario
`fichaje_gateway_login.pvfjffeszsedslmwdvgh` y TLS `verify-full`.
La consulta de metadatos verificó los privilegios y la membresía; la base
sigue con **0 organizaciones, 0 empleados y 0 fichajes**.

En Supabase Edge real, `kiosk` directo sin `x-fichaje-edge` respondió
**403 `AUTH_FAILED`** y `/gateway/kiosk/health/live` respondió
**200 `UP`**. Una lectura de `/gateway/kiosk/health/ready` devolvió
HTTP 200 pero cuerpo **`DEGRADED`** (`database=DEGRADED`) tras el
primer cambio de DSN. Un diagnóstico temporal, limitado a estados y sin
cadena de conexión, comprobó `SELECT 1` **UP** en un arranque nuevo con
el DSN del pooler. Se retiró el diagnóstico y se redeplegó la función
original (versión 9, ACTIVE, `verify_jwt=false`). No se ha repetido una
lectura fiable del readiness tras el redespliegue; el resultado anterior
no se convierte en PASS por inferencia.

La revisión automática rechazó una propuesta de diagnóstico que hacía
fetch desde `kiosk` al gateway que a su vez llama a `kiosk`, por posible
recursión y perturbación del servicio. No se ejecutó ni se reintentó por
otra vía. Falta `verify_staging.py` remoto sin `--local`, SEC-H4-01
real, canary/health/invariantes/alertas, fallo inducido y rollback, carga,
incidente, y backup cifrado más REC-01..03. El restore del runbook exige
un segundo proyecto vacío y no se ha creado por la prohibición expresa
de crear otro Supabase. Tampoco hay destino/journal independiente ni
custodia offline age resueltos. No hay PASS remoto con estas pruebas
obligatorias pendientes. Sin producción, datos laborales reales ni merge.
Las secciones siguientes registran avances anteriores y quedan
sustituidas por esta nota para el estado actual.

## Avance ingress remoto — 2026-09-29 (PR #15)

**HITO 7: BLOCKED — aún no READY FOR PILOT.** Tras autorización expresa del
usuario para una credencial de gestión de la CLI, Supabase CLI 2.90.0 inició
sesión y guardó el token local con modo `0600`; la versión 2.117.0
informó éxito pero no persistió el perfil (su ejecución posterior no encontró
token). La CLI confirmó que el único proyecto modificado es
`fichaje-staging` (`pvfjffeszsedslmwdvgh`, `eu-west-1`). Las Edge Secrets
custom ahora incluyen `FICHAJE_ENV`, `KIOSK_AUTH_URL`,
`KIOSK_ANON_KEY`, `KIOSK_AUTH_PROVISION_KEY`, `KIOSK_PEPPER`,
`KIOSK_NETWORK_SECRET` y `FICHAJE_INGRESS_SECRET`. Valores aleatorios
independientes para pepper/red/ingress y clave de Auth permanecen solo en
stores server-side y archivos temporales `0600`; no en GitHub. Falta
`KIOSK_DATABASE_URL` porque todavía no existe el login restringido.

El secreto ingress de Pages se rotó para emparejarlo con Supabase y se
redeplegó la Pages Function original; despliegue
`26de4dc6.fichaje-staging.pages.dev`. En el origen estable,
`/gateway/export-link/health/live` devolvió **200** `UP`, y
`/gateway/export-link/health/ready` devolvió **200** con Auth/REST/Storage
`UP`, `no-store` y sin CORS abierto observado. La URL Supabase directa
de `export-link` sin `x-fichaje-edge` devolvió **403** en ambas rutas:
rechazo seguro remoto comprobado para ese componente. `kiosk` directo y
por gateway aún devuelve **500** al no tener URL del login PostgreSQL; su
403 y SEC-H4-01 permanecen pendientes. No es PASS de staging completo.

La revisión automática rechazó una operación para crear
`fichaje_gateway_login` y concederle `fichaje_gateway`: la consideró
un cambio de control de acceso que requiere autorización específica, distinta
de la aprobación de la CLI. No se ha reintentado por otra vía. La operación
propuesta es solo para el proyecto de staging, con LOGIN, INHERIT, sin
SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS y una única membresía
`fichaje_gateway`; password aleatorio para un DSN server-side con TLS
`verify-full`. Sin esa aprobación, `verify_staging.py` remoto sin
`--local`, SEC-H4-01 en kiosk, canary/health/invariantes/alertas completos,
fallo inducido/rollback, carga, incidente y REC-01..03 siguen pendientes.
No se creó otro proyecto, no hay empleados ni fichajes reales, producción
ni merge. La sección de avance Pages/Edge debajo es histórica.

## Avance remoto Pages/Edge — 2026-09-29 (PR #15)

**HITO 7: BLOCKED — aún no READY FOR PILOT.** El proyecto Cloudflare Pages existente
`fichaje-staging` tiene variables de producción `FICHAJE_KIOSK_UPSTREAM`,
`FICHAJE_EXPORT_LINK_UPSTREAM`, `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `NODE_VERSION=24` y
`FICHAJE_INGRESS_SECRET` de tipo `secret_text`. No se imprimió ni guardó en
GitHub el valor secreto. Se desplegó con Wrangler el frontend y la Pages
Function original `functions/gateway/[[path]].ts` del bundle de `37aa36c`;
el despliegue limpio quedó activo en
`https://cc923976.fichaje-staging.pages.dev` (alias estable
`https://fichaje-staging.pages.dev`). El proyecto reporta
`uses_functions=true`. El origen estable respondió 200 para la portada y
404 JSON `NOT_FOUND` para una ruta `/gateway/invalid`. La portada sirvió
HSTS, CSP, `X-Robots-Tag: noindex, nofollow` y cabeceras de seguridad;
no se observó `Access-Control-Allow-Origin`. La llamada real a
`/gateway/kiosk/health/live` respondió 500 JSON
`WORKER_ERROR` con `no-store`: es la respuesta de la Edge Function de
Supabase retransmitida por el gateway, que todavía falla al arrancar sin
sus secretos obligatorios. El despliegue diagnóstico temporal se retiró y
se redeplegó la función exacta del repositorio. **No es PASS de gateway ni
rechazo 403 directo.**

La sesión del dashboard Supabase se recuperó mediante GitHub y verificación
de dispositivo; el panel mostró el proyecto existente `fichaje-staging`.
En Edge Function Secrets quedaron guardados `FICHAJE_ENV=staging` y
`KIOSK_AUTH_URL` apuntando al API de este mismo proyecto. Siguen ausentes
los demás valores server-side (incluidos ingress, pepper, red, Auth y DSN de
login restringido). El conector no ofrece escritura de secrets. Se intentó
vincular la CLI de Supabase a la sesión web, pero la revisión automática
rechazó el intercambio del código de verificación por una credencial CLI
persistente: consideró que ampliaba el acceso local sin aprobación específica.
No se ha intentado eludir esa denegación. No se afirma que la CLI haya quedado
autorizada.

Siguen pendientes, por ello, el 403 directo sin firma, `verify_staging.py`
remoto sin `--local`, SEC-H4-01 en Edge real, canary/health/invariantes/alertas,
fallo inducido y rollback, carga, incidente y backup/restore REC-01..03.
No hay PASS remoto con estos FAIL/pendientes. Se mantiene el mismo proyecto
Supabase (15 migraciones, RLS y bucket privado); no se creó otro. Sin
producción, datos laborales reales ni merge. La sección Pages/Auth siguiente
es histórica y queda reemplazada por este avance.

## Avance remoto posterior — 2026-09-28 (PR #15)

**HITO 7: BLOCKED — no READY FOR PILOT.** En el mismo proyecto Cloudflare Pages
`fichaje-staging` (no se creó otro Supabase) se configuraron en producción las
variables de los dos upstreams Supabase, las dos `VITE_*` públicas y
`FICHAJE_INGRESS_SECRET` como `secret_text`. Se desplegó desde el bundle de
`37aa36c` con Wrangler la Pages Function original `functions/gateway/[[path]].ts`
(y se retiró un diagnóstico temporal). La última URL de despliegue fue
`https://cc923976.fichaje-staging.pages.dev`; `https://fichaje-staging.pages.dev/`
responde 200, `/gateway/invalid` responde 404 y `/gateway/kiosk/health/live`
responde **500**. El cuerpo `WORKER_ERROR / Function exited due to an error`
es el 500 de la función Supabase retransmitido por el gateway, no un PASS del
borde. Las cabeceras del HTML remoto incluyen CSP, HSTS y `X-Robots-Tag:
noindex, nofollow`; el gateway tiene `no-store` y no anunció CORS abierto.

**Bloqueador:** no se han configurado los secretos custom de Supabase; la sesión
del Dashboard caducó y se canceló la solicitud de inicio de sesión seguro.
El secreto de ingreso configurado en Pages queda sin pareja en Supabase y debe
rotarse al reanudar antes del ensayo firmado. No se imprimió ni se guardó en
GitHub. En Supabase, la petición directa sin `x-fichaje-edge` sigue dando 500,
no el 403 obligatorio. No se ejecutaron ni se declaran PASS `verify_staging.py`
remoto, SEC-H4-01 real, canary/alertas, fallo/rollback, carga, incidente ni
REC-01..03 remoto. Sin organizaciones, empleados o fichajes reales; sin
producción ni merge. Esta sección prevalece sobre las notas históricas debajo.

## Avance Pages/Auth remoto — 2026-09-28 (PR #15; bundle de 37aa36c)

**HITO 7: BLOCKED — aún no READY FOR PILOT.** Se creó el proyecto Cloudflare Pages
`fichaje-staging` por Direct Upload con datos exclusivamente sintéticos. El ZIP
precompilado del head `37aa36c6333e69e2da538ad02754db2b4bd438dd`
(SHA-256 `79278ff732fac64d8b5fc1d7f163c3a4003918abd581a143fe76120b06a30e4f`)
contenía 12 archivos finales de `dist/`: frontend, `_headers`, `_routes.json`
y `_worker.js` avanzado que delega `/gateway/*` al mismo
`handleGateway` de `edge/gateway.ts` y sirve el resto con `env.ASSETS.fetch`.
Cloudflare Dashboard mostró `12/12 files uploaded`; el navegador remoto abrió
`https://fichaje-staging.pages.dev/` y mostró el formulario de inicio de sesión.
La publicación es una verificación de estáticos, **no** un PASS del gateway:
no están cargados `FICHAJE_INGRESS_SECRET` ni los upstreams, y Cloud Browser
bloqueó una navegación directa a `/gateway/kiosk/health/live` con
`ERR_BLOCKED_BY_CLIENT`. El bundle local respondió 503 `EDGE_NOT_CONFIGURED`
sin secreto y, con un secreto de prueba, firmó el upstream, devolvió `no-store`
y no emitió CORS; esto no sustituye la prueba remota.

En Supabase Auth se guardaron `Site URL` y una redirección exacta como
`https://fichaje-staging.pages.dev` (panel confirmado; 1 URL). El registro
público sigue desactivado. Edge Functions `kiosk` y `export-link` siguen
sin secretos custom y el 403 directo sin firma continúa pendiente. Tampoco
se han ejecutado `verify_staging.py` remoto, SEC-H4-01, canary/alertas,
fallo/rollback, carga, incidente ni REC-01..03 remoto. Sin datos laborales
reales, producción ni merge. La nota de avance anterior debajo es histórica;
esta sección prevalece para el estado remoto actual.

## Avance remoto verificado — 2026-09-28 (PR #15; head de partida 4f99d76)

**HITO 7: BLOCKED — aún no READY FOR PILOT.** En el proyecto existente de Supabase
`fichaje-staging` (ref `pvfjffeszsedslmwdvgh`, `eu-west-1`) se desactivó
`Allow new users to sign up` en Auth; `Confirm email` permanece activo,
Email habilitado, alta anónima y proveedores sociales deshabilitados.
El panel mostró la configuración guardada. Los límites visibles son 150
refresh/5 min, 30 verificaciones/5 min y 30 altas/inicios de sesión/5 min por IP.
`site_url` sigue en `http://localhost:3000` y la lista de redirecciones
vacía: depende de la URL real de Pages, todavía no creada.

Se desplegaron desde el head `4f99d76b534bdebaeaf6185e75fa0c4f05a19426`
las Edge Functions `kiosk` (versión 1, id
`03308b6f-cf1d-4f3c-bbad-e40e3a5f8723`) y `export-link`
(versión 1, id `a090ef8c-f617-4004-9385-bef06b2476b5`).
El conector confirma ambas `ACTIVE` y `verify_jwt=false`, según el contrato
de ingreso firmado. **Una petición GET directa sin firma a `/health/live`
respondió HTTP 500 en ambas**; no se cuenta como rechazo seguro de ingreso:
faltan secretos y configuración server-side obligatorios para el arranque.
El runtime falla cerrado por `CONFIG_REQUIRED` según el código, pero el 403
remoto exigido queda pendiente de comprobar tras la configuración.

El conector de Supabase no ofrece cambios de Auth ni escritura de secretos; Auth
se configuró desde el panel una vez iniciada sesión de forma segura. Cloudflare
Dashboard sigue sirviendo `Performing security verification` en Cloud Browser
tras un único reintento; no se pudo crear Pages. Por tanto, no se ejecutaron
`verify_staging.py` remoto, SEC-H4-01 real, canary, health, invariants,
alertas, fallo inducido y rollback, carga, incidente ni backup/restore remoto.
La CI previa permanece verde, pero solo cubre su entorno efímero. 0 datos
laborales reales, 0 producción, 0 merge. El resto de esta sección H7 conserva
evidencia histórica y descripciones anteriores a este avance; esta nota prevalece
para el estado remoto actual.

## Actualización de staging — 2026-09-28 (head previo: 2b85bc6)

**HITO 7 sigue BLOCKED — no READY FOR PILOT.** Con autorización del usuario se creó un proyecto nuevo
Supabase `fichaje-staging` en `eu-west-1` (ref `pvfjffeszsedslmwdvgh`), separado del
proyecto preexistente `Fichaje APP` (que no se modificó). Se aplicaron en orden los 15 SQL exactos del
head del PR #15; el conector les asignó versiones temporales y se alineó su historial con los 15
timestamps del repositorio. `list_migrations` muestra las 15 versiones esperadas. No se afirma cero
drift hasta ejecutar una comparación de esquema mediante CLI. Tablas de `public` y `private`:
0 sin RLS/FORCE RLS; `fichaje-evidence` es privado; 0 organizaciones, 0 empleados y 0 fichajes.
El asesor de seguridad señala 18 RPC públicas SECURITY DEFINER invocables por `authenticated`,
previstas por el diseño; requieren revisión independiente del código y pruebas de autorización, no
revocación indiscriminada.

La CI del head `2b85bc6` quedó PASS en CI, Database, E2E, OPS-02 y H7. Los logs de Database
confirman 468 pgTAP y 506 comprobaciones de integración. Esta CI es local/efímera y no valida el staging
remoto. `docs/COMPLIANCE.md` se actualizó con fuentes primarias BOE, EUR-Lex y AEPD consultadas en
la fecha; distingue el borrador ministerial de la obligación vigente.

**Bloqueos actuales concretos:** Cloudflare Dashboard mantiene una verificación anti-bot en el navegador de
Work; no se ha creado Pages ni desplegado el frontend. Supabase Dashboard solicita login; la petición segura
de autenticación terminó con control manual del usuario, sin señal visible de sesión iniciada. El conector
Supabase no expone configuración de Auth, secret store ni logins de PostgreSQL. No se han configurado Auth,
secretos, funciones, ingress, journal independiente, backup/restore, alertas, WAF, canary, carga ni incident
drill remotos. `verify_staging.py` sin `--local` no se ha ejecutado: 0 SKIPPED remoto es objetivo pendiente.
El proyecto remoto es aún un esquema vacío sin datos reales, no un entorno listo para el piloto.
No se ha hecho merge ni se ha tocado producción.

## Hito autorizado

### HITO 7 — piloto comercial (preparación técnica)

**ESTADO: BLOCKED — no READY FOR PILOT.** HITO 7 fue autorizado expresamente el 2026-09-28 con STAGING
limitado a datos sintéticos. Todo lo que puede construirse y probarse sin acceso a las plataformas está hecho y
probado de verdad en la **forma de staging en local** (Supabase local efímero, funciones Deno reales, runtime real
de Cloudflare Pages vía workerd), pero el **staging remoto no existe**: este entorno no tiene cuentas ni
credenciales de Cloudflare/Supabase (deben quedar bajo custodia del operador) y su política de red deniega
`api.cloudflare.com`, `api.supabase.com` y `*.pages.dev`. Por eso quedan sin ejecutar las comprobaciones que
exigen la plataforma real, y ninguna se declara PASS. No autorizado y no hecho: producción, empresa piloto real,
datos laborales reales, DNS público definitivo, SLA/RPO/RTO comerciales y merge del PR.

Rama `astra/hito-7-piloto-comercial` desde `main` `bef348de21c920b6a213813266be34c29176cf77` (PR #14);
la rama de trabajo `claude/serene-archimedes-gbd3r9` contiene los mismos commits. PR abierto contra `main`, sin
merge: [PR #15](https://github.com/marioleongayo23-spec/fichaje/pull/15).

#### Entregado (probado en local; CI `.github/workflows/h7.yml`)
- **Borde del mismo origen** (`edge/gateway.ts`, Pages Function `/gateway/*`): rutas y métodos cerrados, sin
  CORS, política de origen y fetch-metadata, cuerpos acotados (8 KiB/1 KiB, también chunked), `no-store`, sin
  reintentos (idempotencia intacta), sin cabeceras de IP hacia arriba. `_headers` con CSP, HSTS y cabeceras de
  seguridad; `_routes.json`.
- **Firma de ingreso** (`supabase/functions/_shared/ingress.ts`): HMAC ligada a método, función, ruta y bytes,
  60 s, rotación sin corte; obligatoria en plataforma. Cambio mínimo en el gateway H4 y el firmador H5 motivado
  por H7 (sin él, la URL pública de las funciones sería una entrada que evita el borde): solo añade la
  verificación antes de interpretar la petición; RLS, idempotencia, inmutabilidad y auditoría no cambian y toda
  la regresión H1-H6 pasa. `verify_jwt=false` declarado en `supabase/config.toml`.
- **SEC-H4-01 tras el borde**: medido con el runtime real: un bucket de red por tenant (peer = proxy), cabeceras
  de IP ignoradas, bloqueo de tenant a los 60 fallos (efecto conservador aceptado), otro tenant intacto.
- **OPS-02 con el borde**: `EdgeLocalDeployer`/`PlatformDeployer`, fallo inducido `edge-signature-broken`
  detectado, alertado, bloqueado y revertido; adaptadores reales PagerDuty Events v2 y GitHub Issues sin PII;
  nueva alerta `KIOSK_AUTH_ABUSE` (hallazgo del ensayo de incidentes).
- **Backup cifrado y restore**: `backup_database.sh` (pg_dump 17 | age, verify-full, fallo cerrado) y
  `restore_database.sh` (restore aislado en una transacción); REC-01..03 ejecutados de verdad con journal en
  instancia independiente por TLS verify-full. **No activado** (sin destino ni custodia reales).
- **Carga, incidente, runbooks**: `h7_load.py`, `h7_incident.py` + `docs/drills/IR-2026-09-28.md`,
  `docs/STAGING.md` (procedimiento del operador), `docs/PILOT_RUNBOOK.md`,
  `scripts/staging/verify_staging.py` (verificador externo, ejecutado en local en cada CI).
- **Documentación legal** (`docs/legal/`, 17 plantillas con marcadores) y revisión normativa parcial en
  `docs/COMPLIANCE.md` (fuentes primarias no accesibles desde este entorno).
- **Revisión de dependencias**: npm raíz/edge y dependencias Deno sin avisos; pines de Python con avisos
  actualizados (`cryptography` 46.0.3 → 50.0.1, `pypdf` 6.1.0 → 6.19.0).

#### Evidencia (ejecución local completa el 2026-09-28, reset desde vacío por bloque)
Suites de la regresión final ejecutadas sobre los commits `2a2debb` (H1-H6, OPS-02, borde, fallo inducido, incidente
y REC) y `fa2982c` (perfil de carga corregido); en cada bloque, `supabase db reset --local --no-seed` + journal:
- **468 aserciones pgTAP PASS**; `h5_render.py` 4 PASS.
- **506 comprobaciones reales H1-H5 + KIO-H6-01 PASS** (H1 102 + H2 70 + H3 80 + H4 181 con KIO-H6-01 63 + H5 73).
- **155 comprobaciones reales OPS-02 PASS** (16 de SEC-OPS-01) con fallos inducidos (`OPS_FAULT_INJECTION=1`).
- Playwright **46/46 PASS**; `scan_secrets.mjs dist test-results`: **0 hallazgos**.
- `h7_edge.py` **66 PASS** (verificador de staging: 30 PASS + 3 TLS omitidas en loopback; arranque en modo
  plataforma sin secreto rechazado); `h7_release.py` **18 PASS**; `h7_incident.py` **19 PASS**; `rec.py` **49 PASS**;
  `h7_load.py` **24 PASS** con 4 CPU y **24 PASS** con todo fijado a 2 CPU (tamaño de runner de GitHub).
- `npm run check` (typecheck app/SW/borde, lint, **122 tests unitarios**, build, escáner de `dist`), Deno
  (`deno check` de gateway y firmador; `network_test.ts` 2, `ops_test.ts` 5, `ingress_test.ts` 3), **63 tests
  Python OPS**, `bash -n scripts/*.sh` y `git diff --check`: PASS (repetidos sobre el árbol final del PR; después de `fa2982c` solo cambia documentación).
- **Incidencias de la regresión, corregidas y documentadas**: (1) `h5.py` y el arnés E2E arrancaban el firmador sin
  puerto y H7 lo trata como plataforma (exige la firma y no arranca): ahora pasan `EXPORT_LINK_PORT` explícito, sin
  cambiar aserciones (`2a2debb`). (2) El perfil de kiosco «8 kioscos sin pausas» dio p95 **1053,7 ms > 1 s** en el
  registro en una ejecución (887–996 ms la identificación): es saturación por Argon2id en el hilo único del
  gateway, no el pico del piloto; se mantiene como límite medido (corrección afirmada, latencia informada) y se
  añade el pico de piloto con cadencia humana explícita, con p95 < 1 s afirmado (`fa2982c`). Argon2 no se toca.
- `pip-audit`: 0 avisos con los pines nuevos; `npm audit`: 0 en raíz, `edge/` y dependencias Deno.

#### Mediciones
- **Carga** (`h7_load.py`, local; no es SLA): web con 20 peticiones concurrentes p95 217–248 ms (4 CPU) y
  308–377 ms (2 CPU); pico de kiosco (8 kioscos ocupados, 3 s para código + PIN y 1 s para elegir) identificación
  p95 607 / 744 ms y registro ≤ 399 / 523 ms (4 / 2 CPU); límites medidos: 8 kioscos sin pausas 0,82–1,22 s y
  20 autenticaciones simultáneas 1,8–2,9 s; 0 errores, duplicados, pérdidas o deadlocks; 32 de 100 conexiones;
  504 llamadas inválidas de telemetría (310/s) rechazadas sin escribir y sin errores en los fichajes.
- **Fallo inducido** (`h7_release.py`): detección y primera página 3,7 s; rollback y alertas resueltas 11,0 s.
- **Incidente IR-01**: detección 11,0 s (incluye el ataque), contención 11,3–11,4 s, rotación del secreto de
  ingreso 18,4–18,8 s, reapertura 25,4–25,8 s; 0 registros laborales afectados (`docs/drills/IR-2026-09-28.md`).
- **REC-02**: backup 2,1–2,3 s; pérdida medida 3,4–3,5 s (1 fichaje posterior al backup, esperado); RTO del ensayo
  56,2–61,3 s. Objetivos propuestos RPO ≤ 24 h / RTO ≤ 8 h: no son compromisos comerciales.
- **SEC-H4-01 tras el borde**: 1 bucket por tenant; bloqueo del tenant a los 60 fallos en 18,6–18,7 s.

#### BLOQUEADORES (intervención humana exacta)
1. **Staging remoto**: el operador crea los proyectos de Cloudflare Pages y Supabase (UE) y carga los secretos en
   sus stores según `docs/STAGING.md` §2-3; ningún secreto en GitHub. Después, `verify_staging.py` sin `--local`
   debe dar PASS sin SKIPPED.
2. **SEC-H4-01 en Supabase Edge**: medir el peer TCP real (`STAGING.md` §4). Si no es fiable, el gateway ya falla
   cerrado y el piloto sigue BLOCKED.
3. **Rutas de alerta reales**: elegir proveedor de guardia y repositorio privado de tickets; el operador guarda
   `OPS_PAGERDUTY_ROUTING_KEY` y `OPS_GITHUB_TOKEN` en el host de operación; ensayar página y ticket en staging.
4. **Backup**: destino privado, custodia offline de la identidad age, host de operación con verify-full y
   restore de ensayo en un segundo proyecto vacío; instancia independiente del journal con CA utilizable desde la
   base gestionada.
5. **Borde**: decisión de subdominio/DNS para reglas WAF de zona y TLS/HSTS reales.
6. **Fallo inducido, carga e incidente en staging** con tiempos humanos reales.
7. **Legal**: verificación con fuentes primarias (BOE, EUR-Lex, AEPD; este entorno también deniega `www.boe.es`,
   `eur-lex.europa.eu` y `www.aepd.es`) y revisión de asesoría; datos reales solo por la empresa y el proveedor.
8. **Revisión independiente** de seguridad del PR, **aceptación de 1-2 empresas piloto** y **aprobación expresa de
   producción**.

#### Siguiente paso
Revisión del PR por el usuario. Con autorización: crear el staging remoto con datos sintéticos según
`docs/STAGING.md` y ejecutar allí los ensayos pendientes. No se continúa automáticamente.

### OPS-02 — observabilidad, canaries, invariantes, alertas y self-healing seguro

**ESTADO: PASS — OPS-02 aprobado expresamente por el usuario e integrado en `main` mediante
[PR #12](https://github.com/marioleongayo23-spec/fichaje/pull/12) el 2026-09-28, con SEC-OPS-01 resuelto.
HITO 7 no estaba iniciado entonces; se autorizó expresamente después, el 2026-09-28 (ver la sección HITO 7).**
Merge: `f43af0d72a1e88cf14cc71a228e1677252dfe16f` (2026-09-28 06:22 UTC; padres
`b64a16a` de `main` y `158de0a` de la rama). Código validado antes del merge:
`158de0a4c61cd62e086634fd3d1aa101a381f05a`; el árbol de `main` en `f43af0d` es idéntico al de `158de0a`.
Rama de origen `astra/ops-02-observabilidad-resiliencia`, creada desde `main` `754c7f184fb14db151303c7ab7db72bb2629e7aa`
(la rama de trabajo `claude/ops-02-observabilidad-resiliencia-kzk0z9` contiene los mismos commits) y
sincronizada el 2026-09-27 con `main` `b64a16a6a21c965b0e01dce6ade7abd3296dca9e` (merge de PR #13, solo
documentación: cronología corregida de HITO 6, estado de OPS-02 y regla de merge explícito en `AGENTS.md`)
mediante un commit de merge, sin reescribir historia.

Validación final previa al merge sobre `158de0a4c61cd62e086634fd3d1aa101a381f05a` (CI del PR y ejecución
local tras reset desde vacío en el mismo orden que CI, registrada en PR #12):
- **468 aserciones pgTAP PASS** (bloques Database y OPS-02).
- **155 comprobaciones reales OPS-02 PASS** (16 de SEC-OPS-01), con fallos inducidos (`OPS_FAULT_INJECTION=1`).
- **506 comprobaciones reales H1-H5 + KIO-H6-01 PASS** (H1 102 + H2 70 + H3 80 + H4 181 con KIO-H6-01 63 +
  H5 73).
- Playwright **46/46 PASS**.
- **111 tests unitarios PASS** y **52 tests Python OPS PASS**.
- Escáner de secretos (`scan_secrets.mjs` sobre `dist` y `test-results`): **0 hallazgos**.
- typecheck, lint, build, Deno (`deno check` de gateway y firmador, `network_test.ts` y `ops_test.ts`),
  `bash -n scripts/*.sh` y `git diff --check`: PASS.

CI del PR sobre `158de0a`: PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36351126479),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36351126544),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36351126543) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36351126585).
CI en `main` sobre el merge `f43af0d`: PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36386134399),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36386134383),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36386134389),
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36386134451) y
[Repository backup](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36386134387).
Esta sección solo registra evidencia ya ejecutada.

Regla absoluta, verificada por la suite: ninguna automatización, script, agente o IA modifica
`time_events`, fichajes originales, decisiones o ajustes de corrección, horas efectivas ni historia
laboral; no hay cierre automático de jornadas ni fichajes inventados. El único dato derivado reescribible
es `private.employee_state`, solo desde fuentes inmutables, con referencia de autorización, idempotente,
auditado y BLOCKED si la fuente es incoherente.

#### SEC-OPS-01 — ingesta de telemetría del navegador (auditoría independiente, 2026-09-26) — RESUELTO
**Causa.** `public.ops_ingest_client_metrics(p_release, p_batch)` solo validaba forma y vocabulario. Cualquier
identidad `authenticated` podía invocarla directamente, sin límite de llamadas, con hasta 100 series y 9.999
eventos por serie, y elegir `p_release`, creando combinaciones nuevas en `private.ops_client_metrics`. Los
límites de `src/lib/telemetry.ts` no eran una defensa. Impacto: métricas contaminables (tasas y latencias),
cardinalidad y crecimiento no acotados y posible degradación de la propia observabilidad.

**Solución** (en la migración de OPS-02, integrada en `main` con PR #12; sin cambios en H1-H6 ni en la UI):
- `release` deja de ser una dimensión de la ingesta: la RPC es `ops_ingest_client_metrics(p_batch)`, ni
  `ops_client_metrics` ni `ops_client_metrics_snapshot` tienen columna de release y el navegador ya no la envía.
  La identidad del artefacto que comprueba el gate RES-02 pasa a `<meta name="fichaje-release">` de
  `index.html`. Los eventos de servidor siguen llevando release y commit; la telemetría del navegador se
  relaciona con una release solo por tiempo (cubo de 5 min frente a promociones y rollbacks del gate).
- Validación en servidor: claves exactas, vocabulario cerrado, ≤100 series distintas por llamada, 1..1000
  eventos por serie y suma de duraciones dentro de los límites de sus cubos (+Inf ≤ 120 s). Un error responde
  `INVALID_INPUT` y no escribe nada.
- Rate limiting persistente en servidor por identidad y ventana fija de 5 min: 30 llamadas (también las
  rechazadas), 2.000 eventos y 200 series. Límites globales intencionados por ventana: 5.000 identidades,
  200.000 eventos y 1.000 filas por cubo. Están en `private.ops_ingest_limits` (una fila con CHECK acotados;
  solo el propietario de la base la ajusta; sin fila no se acepta nada). Un rechazo por cuota confirma el
  intento y responde 200 `{"accepted":0,"limited":true}`; el navegador descarta ese lote.
- Concurrencia: bloqueos de fila con orden fijo (ventana nueva → identidad → ventana → métricas).
- Sin PII: el emisor es `sha256(sal aleatoria de la ventana ‖ uid)`; no se guarda uid, email, membresía,
  empleado, nombre ni código. Solo se conservan la ventana actual y la anterior (sin actividad, hasta la
  siguiente llamada) y la sal se borra con su ventana. Nunca aparece en métricas, logs, alertas ni
  respuestas, ni es una dimensión. Los cubos del navegador se retienen 7 días (purga acotada).
- Señal no confiable: `trust: untrusted` en `ops/contract.json`. Ninguna alerta, gate, rollback, reintento ni
  reconstrucción la lee; las señales críticas salen de eventos de servidor, health, canary, invariantes y
  backups.
- Frontend: sin `p_release` y con duraciones acotadas a 120 s. `SECURITY`, `ARCHITECTURE`, `RUNBOOKS` y
  `ACCEPTANCE_TESTS` actualizados.

**Evidencia real** (local, 2026-09-26, tras reset desde vacío, mismo orden que CI; nada se ejecuta a través
del frontend salvo el E2E):
- `supabase test db`: **468 aserciones pgTAP PASS**. `ops_observability.test.sql` pasa de 69 a 116, con 48
  SEC-OPS-01: consecutivas cortadas en la cuota con los rechazados confirmados, `count=9999`, >1000, 101 series,
  duplicadas, duraciones fuera de su cubo, fuera de vocabulario, identificadores y release dentro del lote
  rechazados sin escritura; firma sin release; segunda identidad; cuotas de series y eventos; cubo lleno,
  volumen e identidades globales; fallo cerrado sin límites; expiración con reset, purga, sal distinta y
  retención; RLS forzada y ningún rol API/OPS con acceso a las tablas de cuota.
- `tests/integration/ops02.py`: **155 comprobaciones reales PASS** (139 + 16 SEC-OPS-01), con llamadas HTTP
  directas a PostgREST sin navegador: 40 llamadas consecutivas → exactamente 30 aceptadas y cuota persistente;
  segunda identidad no bloqueada; 13 cargas infladas/fuera de vocabulario/identificadoras, `count=9999`
  incluida, rechazadas sin escritura; anon rechazado; 20 releases aleatorias rechazadas sin columna ni fila;
  100 series acotadas; **2 identidades × 40 llamadas simultáneas → exactamente 30 aceptadas cada una, sin
  errores ni deadlocks**; reset y purga al expirar la ventana; límites globales intencionados; 1.000
  CLOCK_REGRESSION falsos solo en el dashboard, sin fuente de alerta; historia laboral, proyección,
  reparaciones, alertas, release (sin rollback), métricas de servidor y decisiones idénticas antes y después;
  seudónimos sin uid/email fuera de métricas y crecimiento acotado. El escáner final incluye uid, emails,
  contraseñas y seudónimos de las identidades atacantes: 0 hallazgos en logs, métricas, alertas e informes.
  El gate RES-02 (rollback real incluido) pasa con la nueva identidad del artefacto.
- `h5_render.py` (4) y `h5.py` **506 comprobaciones PASS** (H1 102 + H2 70 + H3 80 + H4 181 con KIO-H6-01 63 +
  H5 73), sin cambios.
- Playwright + Chromium tras reset desde vacío: **46/46 PASS** (el navegador solo envía `p_batch`;
  el almacén no tiene columna de release); `node scripts/scan_secrets.mjs dist test-results`: 0 hallazgos.
- `npm run check`: typecheck, lint, **111 tests unitarios**, build y escáner de `dist` PASS;
  `python3 -m unittest discover -s tests/ops` **52 PASS** (5 nuevos: la telemetría del navegador nunca cambia
  decisiones de alertas, ni la leen gate, reparaciones o jobs, e identidad del artefacto por `<meta>`); Deno
  `ops_test.ts` 5 y `network_test.ts` 2 PASS; `deno check` de kiosk y export-link, `bash -n scripts/*.sh`,
  `py_compile` y `git diff --check` PASS.

CI del PR sobre `7113ddeebb204c2dc5f4411ef429a60df3a14253` (SEC-OPS-01): PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017083),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017071) (468 pgTAP y 506
comprobaciones reales H1-H5 + KIO-H6-01),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017066) (46/46; escáner 0 hallazgos) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36241017088) (468 pgTAP y 155
comprobaciones reales, las 16 de SEC-OPS-01 incluidas). El commit posterior solo registra esta evidencia; sus
Checks repiten automáticamente toda la validación.

Riesgo residual: una identidad autenticada todavía puede sesgar agregados informativos dentro de su cuota
(por diseño no deciden nada). Las llamadas inválidas no escriben ni consumen cuota; limitar la inundación
HTTP en sí corresponde a la plataforma (H7). Con el sistema inactivo, los contadores seudónimos de la última
ventana persisten hasta la siguiente llamada.

Entregado:
- OBS-01: contrato `ops/contract.json`; eventos JSON por allowlist en scripts (`scripts/ops/opslib.py`),
  gateway del kiosco y firmador (`supabase/functions/_shared/ops.ts`) con release, commit y `request_id`;
  las excepciones se reducen a una clase estable (sin SQL, parámetros, cuerpos ni trazas).
- OBS-02: métricas en formato Prometheus derivadas de eventos e informes (`metrics.py`); telemetría del
  navegador agregada (`src/lib/telemetry.ts`) enviada por la RPC de solo escritura
  `public.ops_ingest_client_metrics` (cubos de 5 min sin identidad ni release, vocabulario cerrado, cuotas en
  servidor y señal no confiable: SEC-OPS-01).
- OBS-03: `/health/live` y `/health/ready` (cacheado 5 s, acotado a 2 s) en gateway y firmador; `health.py`
  agrega app, API, Auth, PostgreSQL (`private.ops_db_health()`), gateway y firmador en UP/DEGRADED/DOWN.
- OBS-04: `canary.py` web y kiosco sobre tenant sintético; si un ciclo quedó a medias rota a un empleado
  sintético nuevo y deja la sesión abierta como está.
- OBS-05: 21 invariantes read-only (`private.ops_invariant_*`, `invariants.py`) con evidencia append-only y
  líneas base de originales; el detalle solo se consulta por tenant.
- OBS-06: `alerts.py` con catálogo, severidad, runbook, CRITICAL→pager, WARNING→ticket, FIRING/RESOLVED,
  formato `fichaje.alert.v1` y sink de prueba local.
- OBS-07: roles `fichaje_ops*` NOLOGIN/NOINHERIT/NOBYPASSRLS; monitor (agregados), reviewer (un tenant, solo
  lectura) y repairer (solo reconstrucción); ningún OWNER/ADMIN/EMPLOYEE/anon alcanza funciones o tablas OPS.
- RES-01 `retry.py`/`jobs.py`; RES-02 `release_gate.py` (`promote()` + `LocalDeployer` de releases
  inmutables); RES-03 `rebuild_projection.py` (`--check` READ ONLY, `--apply` autorizado); RES-04
  `backup_monitor.py` y `.github/workflows/ops-monitor.yml` (diario, token de solo lectura).
- Runbooks (`docs/RUNBOOKS.md`, 12), inyección de fallos `faults.py` (solo loopback y
  `OPS_FAULT_INJECTION=1`), puerta `.github/workflows/ops02.yml`, `ci.yml` con los tests OPS-02 y
  `bash -n scripts/*.sh`, reglas nuevas en `scan_secrets.mjs`. Documentación: ARCHITECTURE (implementación y
  fuente de verdad de RES-03), SECURITY, RECOVERY y ACCEPTANCE_TESTS (asignación de evidencia OPS-02).

Evidencia local ejecutada el 2026-09-26 (Docker; Supabase CLI 2.117.0, PostgreSQL 17, GoTrue, PostgREST y
Storage locales, Deno 2.9.6, Node 24.19.0, Python 3.12), sobre el código previo a SEC-OPS-01 (`8e54371`; la
evidencia posterior está en la sección SEC-OPS-01):
- `supabase db reset --local --no-seed` + `journal_init.py` + `supabase test db`: **421 aserciones pgTAP
  PASS** (352 previas + 69 de `ops_observability.test.sql`).
- `python3 tests/integration/ops02.py` tras el mismo reset: **139 comprobaciones reales PASS**. Releases
  construidas desde el commit con el gateway y el firmador reales; tenants sintéticos. Fallos inducidos de
  verdad y detectados por el código operativo sin modificar: API 5xx, Auth rechazando, latencia, PostgreSQL
  rechazando, contenedor Auth detenido y PostgreSQL pausado (health, gateway, canary, alertas y
  resolución); ACK perdido tras commit y timeout de cliente (mismo payload y clave, una mutación, audit y
  recibo); error permanente, backoff acotado y circuito; POLICY_REQUIRED y CLOCK_REGRESSION del motor real;
  deriva de proyección, originales borrados y alterados, audit cross-tenant, ajuste de una decisión
  rechazada, guarda deshabilitada, sesión abierta antigua y exportación atrasada; reconstrucción exacta e
  idempotente con historia byte a byte igual y BLOCKED ante fuente alterada; jobs de exportación,
  retención y journal; release con defecto real en el gateway (lo detecta el canary de kiosco) y release
  sin asset (lo detecta health) con rollback automático; backups correcto, cercano al umbral, antiguo,
  fallido, ausente, sin artefacto, corrupto y sin checksums con PostgreSQL siempre `NOT_CONFIGURED`;
  escáner final sin secretos, PIN, emails, nombres, códigos, motivos ni identificadores de registro.
  Si falla, la suite solo imprime la etiqueta del check, el tipo o clase de error, ubicaciones de código
  y eventos por campos enumerados (mismo criterio que H4): nunca valores, SQL ni cuerpos HTTP.
- `python3 -m unittest discover -s tests/ops`: **47 tests PASS**; Deno `ops_test.ts`: **5 PASS**;
  `deno check` de kiosk y export-link PASS.
- `npm run check`: typecheck, lint, **109 tests unitarios**, build y escáner de `dist`: PASS.
  `bash -n scripts/*.sh`, `py_compile` y `git diff --check`: PASS.
- Playwright 1.56.1 + Chromium (escritorio y móvil) tras reset desde vacío, contra Auth/PostgREST/Storage/
  PostgreSQL, gateway y firmador reales: **46/46 PASS** (45 de H6 sin cambios + `telemetry.e2e.ts`: el
  navegador solo envía agregados acotados, sin tenant, persona, registro, request_id, email ni token).
  `node scripts/scan_secrets.mjs dist test-results`: 0 hallazgos.

- Regresión completa tras reset desde vacío: `h5_render.py` (4 tests) y `h5.py` **506 comprobaciones PASS**
  (H1 102 + H2 70 + H3 80 + H4 181 con KIO-H6-01 63 + H5 73), sin cambios respecto a H6.

CI del PR sobre `1e36d23` (código previo a la revisión automática): PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038022),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038009) (506 comprobaciones reales),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038062) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224038021) (139 comprobaciones reales
con fallos inducidos en GitHub Actions).

CI del PR sobre el código final `8e54371377a45aa54faedaf2507dacc6f5426e0e` (tras la revisión automática): PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508387),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508381) (506 comprobaciones reales
H1-H5 + KIO-H6-01),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508379) (46/46; escáner 0 hallazgos) y
[OPS-02](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36224508377) (421 pgTAP y 139
comprobaciones reales con fallos inducidos). El commit posterior solo registra esta evidencia; sus Checks
repiten automáticamente toda la validación.

Revisión automática del PR (Codex), 5 hilos verificados, respondidos y resueltos; corregidos con tests:
- Una alerta cuya entrega fallaba quedaba FIRING sin reintento: ahora hay outbox persistente y cada
  notificación se reintenta con el mismo `notification_id` hasta que su ruta la acepta (FIRING antes que
  RESOLVED); en producción el motor exige las rutas pager y ticket configuradas.
- Las líneas base de originales podían avanzar con una guarda append-only deshabilitada (hallazgo
  estructural sin tenant): cualquier hallazgo estructural CRITICAL congela todas las líneas base de la
  ejecución (`baselines_frozen`).
- Una purga reproducida tras restore (evidencia solo de tenant) marcaba a todo el tenant como purgado:
  ahora solo cuenta un empleado cuya historia tiene la forma de una purga legal (falta la secuencia 1, resto
  contiguo que empieza en CLOCK_IN) y un recibo huérfano solo es INFO si es anterior al corte de una purga
  laboral registrada. Sobre el dataset real de H1-H5 esto devuelve a comprobación completa a un empleado no
  purgado y hace aflorar `SEQUENCE_CONTIGUOUS` en el fixture histórico privilegiado de H5 (ya incoherente).
- Los jobs se modelan como mutaciones: solo se reintentan con idempotencia garantizada en servidor
  (exportación y journal); `purge_operational` añade un manifiesto por llamada y se ejecuta una sola vez.

Hallazgos corregidos durante la validación:
- `record_time_event` responde VERSION_CONFLICT con HTTP 500 (SQLSTATE 40001): la clasificación operativa lo
  trataba como UPSTREAM_5XX y lo reintentaba. Ahora el código estable manda sobre el estado HTTP, como en
  `src/lib/errors.ts`; el conflicto se intenta una sola vez.
- El probe de la aplicación aceptaba un asset ausente porque el host estático responde `index.html` con 200
  (fallback SPA, igual que Cloudflare Pages): ahora comprueba tipo y contenido.
- `kiosk_identification.test.sql` era intermitente bajo carga: un INSERT dependía de dos
  `clock_timestamp()` por defecto y saltaba el CHECK de 60 s antes del índice único. Solo cambia el test;
  las inserciones reales ya fijan `t` y `t+60 s`.

Límites: sin producción, staging, DNS, dominio, Cloudflare/Supabase remotos, secretos, claves age ni datos
reales. RES-02 se ha probado en un arnés CI aislado y efímero (`LocalDeployer`); su repetición en staging
sigue siendo puerta de H7. Rutas reales de alerta (pager/ticket), dashboards, retención de la evidencia OPS,
canary e invariantes programados contra producción y el adaptador de despliegue real
quedan para H7. `ops-monitor.yml` solo se ejecuta desde `main`: ya está integrado (diario, 03:17 UTC), pero
a 2026-09-28 no tiene ninguna ejecución registrada; su primera ejecución real sigue pendiente. El backup
PostgreSQL real sigue bloqueado hasta H7 y se informa `NOT_CONFIGURED`, nunca en verde. La telemetría
del navegador es no confiable y tiene cuotas en servidor (SEC-OPS-01): no alimenta ninguna decisión.

### HITO 6 — UX/UI + PWA sobre H1-H5, con KIO-H6-01 resuelto

**ESTADO: PASS — HITO 6 aprobado técnicamente por autorización expresa del usuario el 2026-09-26, después
de una auditoría independiente posterior al merge.** Cronología (corrección documental del 2026-09-26):
1. [PR #10](https://github.com/marioleongayo23-spec/fichaje/pull/10) se integró en `main` el 2026-09-26
   (commit de merge `3c374358e1c17853c62cb29047642bee37a4efe5`, fechado a las 03:47 UTC) antes de la
   aprobación formal y sin autorización expresa de merge del usuario: el merge fue prematuro.
2. Después, HITO 6 se auditó de forma independiente; la revisión confirma que el contenido integrado supera
   la puerta técnica H6, por lo que el código no se revierte.
3. HITO 6 queda aprobado ahora por autorización expresa del usuario. La aprobación no fue anterior al merge.

Rama de origen `astra/hito-6-ux-pwa`. Merge: `3c374358e1c17853c62cb29047642bee37a4efe5`. Código probado:
`80a5ccd4874d53e79162169b0f675d998f1fb353`; commit final revisado:
`49d74ea6731d62e5d2374a8aba573fecfb36c28c` (solo documentación, Checks repetidos en verde).
CI en `main` sobre el merge `3c37435`: PASS en
[CI general](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878110),
[Database](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878128) (352 pgTAP;
506 comprobaciones reales, 63 de ellas KIO-H6-01),
[E2E](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878067) (45/45; 0 hallazgos del
escáner) y [Repository backup](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36215878111).
Esta sección solo registra evidencia ya ejecutada.

Evidencia de CI del código `80a5ccd`:
- [Database H1 + H2 + H3 + H4 + KIO-H6-01 + H5, run 36192804446](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36192804446): PASS.
  Supabase local efímero reconstruido desde vacío (`supabase db reset --local --no-seed`), Deno 2.9.6
  strict check de kiosk y export-link y tests Deno de red. **352 aserciones SQL/pgTAP PASS**
  (297 + 55 KIO-H6-01). **506 comprobaciones de integración real PASS: 102 H1 + 70 H2 + 80 H3 +
  181 H4 (incluidas 63 KIO-H6-01) + 73 H5**, con el gate KIO-07 de PIN, IP, digests y secretos de challenge.
- [Browser E2E, run 36192804457](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36192804457): PASS.
  **45/45 Playwright** (Chromium escritorio y móvil) contra Auth/PostgREST/Storage/PostgreSQL, gateway
  y firmador reales; `scan_secrets.mjs dist test-results`: 0 hallazgos.
- [CI general, run 36192804458](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36192804458): PASS
  (npm ci, typecheck, lint, 98 tests unitarios, build, escáner de secretos, shell y whitespace).
El commit posterior solo registra esta evidencia; sus Checks repiten automáticamente toda la validación.

**KIO-H6-01** (detectado al iniciar H6): `kiosk/authenticate` exigía `action` y `expected_version`
antes de validar código+PIN y ningún endpoint del kiosco devolvía estado ni versión, así que la UI no
podía ofrecer las acciones válidas. El usuario autorizó expresamente el 2026-09-25 resolverlo con un
contrato cerrado. Implementado en `supabase/migrations/20260925000100_kiosk_identification.sql` y
`supabase/functions/kiosk/index.ts`:
- `/authenticate` recibe solo código+PIN. Tras el PIN correcto el servidor resuelve empleado, estado
  OUT/WORKING/PAUSED y versión autoritativos y devuelve únicamente `state`, `version`, `actions` y un
  challenge por acción legal (OUT→CLOCK_IN; WORKING→BREAK_START+CLOCK_OUT; PAUSED→BREAK_END+CLOCK_OUT).
- Cada challenge queda ligado en servidor a organización, dispositivo, empleado, acción,
  `expected_version`, request_id propio, versión de credencial y TTL ≤ 60 s; no hay challenge genérico.
  Los hermanos comparten `grant_id`; ejecutar uno consume todos, y el segundo no crea evento.
- `/record` ya no acepta `employee_id` (lo determina el challenge). El gateway solo puede ejecutar
  `kiosk_admin_prepare/apply`, `kiosk_auth_begin`, `kiosk_auth_grant` y `kiosk_record`;
  `kiosk_auth_finish` se elimina y `kiosk_record_event` pasa a ser interno.
- Se mantienen Argon2id, pepper, límites 5/30/60, IP minimizada, errores genéricos, suelo de 300 ms,
  `no-store`, hashes de challenge, idempotencia, revocación, recuperación de ACK, máquina H2 y
  RLS/FORCE RLS. Scope `kiosk_grant` de solo lectura de la proyección del empleado verificado; el
  dispositivo sigue sin acceso libre a estado, eventos, directorio, historial ni RPC humanas.
- Fallo encontrado y corregido durante la validación: `kiosk_record` hacía dos limpiezas de contextos
  por transacción y el doble clic concurrente (12 peticiones) produjo `40P01`. Los scopes nuevos solo
  insertan la fila de su transacción (una única limpieza, como H1-H4); revalidado sin deadlocks.

**UI/PWA H6** (sin cambios de H1-H5 salvo KIO-H6-01): login, sesión, selector de organización,
empleado (fichar, «Mi registro», correcciones, exportación propia), OWNER/ADMIN (empleados, personas y
roles, horarios, bandeja de correcciones, clasificación, exportaciones con entrega controlada, kioscos y
PIN), kiosco `/kiosco` conectado al gateway real, PWA instalable con service worker de shell público
sin cola offline ni Background Sync. Decisiones y límites en `docs/UI_PWA.md`.

Evidencia local ejecutada el 2026-09-25 (entorno de edición con Docker; Supabase CLI 2.117.0,
PostgreSQL 17, GoTrue/PostgREST/Storage locales, Deno 2.9.6, Node 24.19.0, Python 3):
- `supabase db reset --local --no-seed` + `python3 tests/integration/journal_init.py` +
  `supabase test db`: **352 aserciones SQL/pgTAP PASS** (297 previas + 55
  `kiosk_identification.test.sql`), tres ejecuciones consecutivas.
- `python3 tests/integration/h5_render.py` PASS y `python3 tests/integration/h5.py` (cadena real
  completa): **PASS H1 102 + H2 70 + H3 80 + H4 181 + H5 73 = 506 comprobaciones**; H4 incluye las
  **63 comprobaciones KIO-H6-01** de `tests/integration/kio_h6.py` (tenant propio, gateway HTTP real)
  y el gate KIO-07 ampliado: PIN, IP y secretos de challenge ausentes de DB, logs de contenedores,
  gateway, salida y artefactos (los secretos de challenge solo existen en las respuestas HTTP).
- KIO-H6-01 cubierto en real: OUT/WORKING/PAUSED con solo acciones legales y versión correcta;
  challenges independientes; ejecutar uno invalida el hermano (secuencial y 8 peticiones
  concurrentes: una acción, un evento); caducado; reutilizado; otra acción, versión, request,
  empleado, dispositivo y tenant; PIN erróneo y código inexistente indistinguibles (≥ 300 ms);
  dispositivo revocado, empleado desactivado por RPC real y reset de credencial; límites de
  empleado y dispositivo; dispositivo sin tablas, RPC humanas ni rutas de consulta.
- Gateway: `deno check` estricto de kiosk y export-link y **2 tests Deno** de red PASS.
- `npm run check` (typecheck app+SW, lint sin avisos, **98 tests unitarios**, build, escáner de
  secretos de `dist`): PASS. `bash -n scripts/*.sh`, `py_compile` y `git diff --check`: PASS.
- Playwright 1.56.1 + Chromium, proyectos escritorio 1280×800 y móvil Pixel 5, tras
  `supabase db reset --local --no-seed` + `journal_init.py`, contra Auth/PostgREST/Storage/PostgreSQL
  locales, gateway Deno y firmador H5 reales: **45/45 PASS** (a11y, empleado, gestión, kiosco, PWA).
  Kiosco: empleado sin email ficha OUT→WORKING→PAUSED→OUT solo con las acciones ofrecidas por el
  servidor; confirmación solo tras el ACK (ACK retenido: solo «Enviando…»); ACK perdido tras commit y
  timeout antes del servidor → resultado desconocido y un único evento; doble toque; challenge
  reutilizado y caducado; dispositivo revocado; recibo limpio a 10 s y pantalla identificada en < 15 s
  (medido en la página); axe en todos los pasos; PIN, código, credencial, JWT del dispositivo y los 7
  secretos de challenge ausentes de almacenamiento, cachés, consola, logs y artefactos.
  `node scripts/scan_secrets.mjs dist test-results`: 0 hallazgos.
- Fallo intermedio corregido: la primera ejecución dio 44/45 porque la pantalla identificada se
  limpiaba a 15 s exactos más el renderizado (15,9 s medidos con sondeo de 1 s). El temporizador pasa
  a 14 s (estrictamente < 15 s) y la prueba mide dentro de la página con sondeo de 50 ms.

Límites: solo datos y secretos sintéticos efímeros; sin producción, despliegue ni datos reales. El
gateway y el firmador se sirven por proxy del mismo origen (`vite preview` en pruebas); el proxy
inverso de producción y su efecto en SEC-H4-01 quedan para H7. El listado de kioscos se deriva del
audit (sin nombre ni caducidad). Sin OPS-02 ni H7. OPS-02 permanece después de H6 y antes de H7.

HITO 0 Bootstrap aprobado por el usuario e integrado en `main` mediante PR #1 el 2026-09-21.
Rama de origen: `astra/hito-0-bootstrap`. Merge: `f9a02bb150b424d9cf0a47b741496c997b7bc085`.
HITO 1 aprobado por el usuario e integrado en `main` mediante PR #4 el 2026-09-22.
Rama de origen: `astra/hito-1-identidad-rls`. Merge: `ffd12c689824886abd8ba6f1e836057fc43ee9a8`.
HITO 2 aprobado por el usuario e integrado en `main` mediante PR #5 el 2026-09-22.
Rama de origen: `astra/hito-2-motor-horario`. Merge: `e4edd0d451627d6cd6e25aafc31819a77ee76116`.
HITO 3 aprobado por el usuario e integrado en `main` mediante PR #7 el 2026-09-23.
Rama de origen: `astra/hito-3-correcciones`. Merge: `a848c1c5adef50ada215d7362089db5da3ebf3f8`.
HITO 4 aprobado por el usuario, incluida SEC-H4-01, e integrado en `main` mediante PR #8 el 2026-09-23.
Rama de origen: `astra/hito-4-kiosco`. Merge: `76922f352a64f3bbf0d1d7ece2c7ae155f58d1a0`.

HITO 5 aprobado por el usuario e integrado en `main` mediante PR #9 el 2026-09-25.
Rama de origen: `astra/hito-5-informes-retencion`. Merge: `748186125194cf4819357d57a4d8567a8cdf3bab`.
HITO 6: PR #10 integrado en `main` el 2026-09-26 antes de la aprobación formal (merge prematuro, sin
autorización expresa); auditado después de forma independiente y aprobado técnicamente ahora por
autorización expresa del usuario, sin revertir el código.
Rama de origen: `astra/hito-6-ux-pwa`. Merge: `3c374358e1c17853c62cb29047642bee37a4efe5`.
OPS-02 aprobado expresamente por el usuario, con SEC-OPS-01 resuelto, e integrado en `main` mediante
[PR #12](https://github.com/marioleongayo23-spec/fichaje/pull/12) el 2026-09-28.
Rama de origen: `astra/ops-02-observabilidad-resiliencia`. Merge: `f43af0d72a1e88cf14cc71a228e1677252dfe16f`.
Estado actual: HITO 6 aprobado y cerrado según la cronología corregida arriba. OPS-02 PASS, aprobado y
cerrado (ver la sección OPS-02 al inicio). HITO 7 sigue SIN iniciar: ya no está bloqueado por OPS-02, pero
requiere una autorización expresa y posterior del usuario para comenzar.

## Entregado en H0
- Diez documentos de gobierno y diseño coherentes: arquitectura, modelo, roles/RLS, máquina de
  estados, tiempo servidor, inmutabilidad/correcciones, audit, concurrencia/idempotencia y kiosco.
- Contratos de exportación, retención, aceptación, recuperación y roadmap con puertas por hito.
- React + TypeScript + Vite, cliente Supabase lazy, configuración pública validada y texto neutro.
- Lockfile y CI: npm ci, typecheck, lint, tests, build; sin credenciales ni despliegue.
- Backup manual de repo: bundle con historial/refs, snapshot, checksums y rclone opcional.
- Backup PostgreSQL bloqueado incondicionalmente; documentación de conexión/cifrado/restore futuros.

## Evidencia H0
Entorno local Node 24.19.0, npm 11.9.0, Linux.
`npm ci`, `npm run check`, `bash -n scripts/backup_repo.sh scripts/backup_database.sh` y
`git diff --cached --check`: PASS en validación local previa a publicación del PR.
Suite: 21 tests (configuración/render, recuperación real de bundle sintético, shallow/dirty,
fallo de verificación remota, bloqueo DB y contratos de workflows).
El estado ejecutado de GitHub Actions se consulta en Checks del PR; no sustituirlo por resultado local.
En H0 no había pruebas SQL/RLS/Auth/kiosco reales. La evidencia de H1 figura más abajo.

## Límites registrados al cierre de H0
No base remota, credenciales, Drive, datos personales reales, migraciones aplicadas, diseño visual,
service worker ni configuración Cloudflare/producción. Backup remoto real y restore DB NO ensayados.
Normativa base enlazada y fechada; revisar convenio/sector y requisitos vigentes antes de piloto.
No añadir Secrets ni activar backup DB en este hito. No hacer merge automático.

## OPS-01 — backup online
PASS. PR #2 integrado en `main`. Backup privado generado en cada push a main, diariamente a
01:30 UTC y manualmente; artefacto GitHub conservado 14 días, sin credenciales Google en GitHub.
Primera copia secundaria subida y verificada en `Fichaje APP - BACKUP/01 - Repo Snapshots`.
Artefacto GitHub run 35619934149: SHA-256
`545bd31a02ec4afe66e3c87daa0b89c2297867c992bd2a2d6f837bfa5c5e38a7`.
Checksums internos PASS; bundle restaurado en repositorio vacío y `main` restaurado coincide con
`c177548662735fa257390e6775f2731d7f01fe98`. Copia diaria a Drive programada en ChatGPT a las
05:00 Europe/Madrid. Backup PostgreSQL sigue bloqueado.

## HITO 1 — identidad y aislamiento
ESTADO: PASS — H1 aprobado por el usuario y PR #4 integrado en `main`, incluidas las correcciones SEC-H1-01 y AUD-H1-01.
Rama: `astra/hito-1-identidad-rls`, base `39ff3e041e49396fa177e13a0b2e4ebbef034da6`.

Entregado: Supabase local CLI 2.117.0 / PostgreSQL 17; migración de organizaciones,
membresías, empleados sin email, vínculo Auth opcional, roles y FK compuestas; RLS/FORCE RLS,
GRANT mínimos, helpers técnicos, bootstrap privado, transferencia OWNER atómica, revocación,
invitaciones ligadas a identidad verificada/tenant/rol y TTL. Auditoría e idempotencia para
mutaciones H1, bloqueo por organización y versiones. No motor horario ni UI.
Contrato y comandos reproducibles: `supabase/README.md`.

Evidencia ejecutada el 2026-09-22, commit de código `08a7f79a89328f3c4ad5e2d116e1def35b03338a`:
- [Database H1, run 35695686230](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35695686230): PASS.
  Runner Ubuntu 24.04, Supabase CLI 2.117.0, PostgreSQL 17.6.1.167, GoTrue 2.196.0,
  PostgREST 16.2 y Storage 1.72.1. `supabase start` y `supabase db reset --local --no-seed`
  aplican la migración desde vacío; no seed ni base remota.
  `supabase test db`: **85 pruebas SQL/pgTAP PASS**, dos organizaciones × tres roles,
  RLS/FORCE, anon, FK/UUID/join/RPC cruzados, mínimo OWNER, transferencia y revocación.
  `python3 tests/integration/h1.py`: **92 comprobaciones reales PASS**, cuentas sintéticas
  creadas en GoTrue, login real y JWT usados contra PostgREST y Storage. Invitaciones de un uso,
  expiración/identidad/emisor; identidad con roles distintos en dos tenants; 12 requests iguales
  con un único recibo/audit; 12 versiones concurrentes con un ganador; fallo audit revierte datos
  y recibo; revocación que toma el lock primero rechaza la escritura en espera y el JWT anterior.
  Contenedores destruidos con `supabase stop --no-backup` al finalizar.
- [CI general, run 35695686271](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35695686271): PASS.
  npm ci, typecheck, lint, **21 tests**, build, sintaxis shell y whitespace.
- Entorno de edición sin Docker/PostgreSQL: DB ejecutada realmente en CI, no aquí.
  `npm ci && npm run check`, `bash -n scripts/*.sh`, `git diff --check`: PASS local.

Fallos previos corregidos y revalidados: atributos de roles compatibles con el usuario de
migraciones de Supabase; acceso a Auth mediante dos adaptadores privados de lectura (ver SECURITY);
fixture OWNER con constraint diferida; proveedor email/password activo con signup público
bloqueado. Ningún test desactivado ni RLS/Auth simulado en JavaScript.
El commit posterior de cierre solo actualiza este documento; los Checks del PR registran
además la ejecución automática sobre ese commit.

Límites: solo stack local efímero CI, datos sintéticos. No proyecto Supabase remoto, producción,
secretos GitHub, envío de invitaciones, kiosco, informes ni diseño visual. Baja tenant bloquea
JWT previo por RLS/RPC; no revoca sesiones globales de otras organizaciones. Backup DB sigue bloqueado.

## Revisión SEC-H1-01 / AUD-H1-01
Segunda migración: capacidad de tenant protegida por xid8/backend/principal, sin GUC como
fuente de autorización; escritor ordinario sin acceso global. Guard solo lee identidad/invitaciones
y emite contexto; bootstrap y aceptación tienen roles separados, NOLOGIN/NOBYPASSRLS, políticas
acotadas y GRANT específicos. Scope ordinario no puede cambiar de tenant dentro de la transacción.
Los contextos de transacciones finalizadas nunca autorizan otra transacción; se limpian al siguiente bind.
Auditoría before/after de role, active, membership_id y versiones; transferencia con ambas membresías.
Sin email, token, nombre ni payload completo. Pruebas negativas del rol técnico y de función
intencionadamente sin filtro; reconstrucción exclusiva desde audit en SQL y REST real.
Evidencia de las correcciones ejecutada el 2026-09-22, código `43a2b6f418aca4d0a353773ae84c3d03262810f7`:
- [Database H1, run 35729889526, intento 2](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35729889526/attempts/2): PASS.
  `supabase start` y `supabase db reset --local --no-seed` aplican ambas migraciones desde vacío.
  **106 tests SQL/pgTAP PASS**: 85 existentes y 21 de los hallazgos; sin contexto no hay lectura,
  GUC falsificada no autoriza, writer no fabrica/borra contexto ni cambia de tenant, lectura/INSERT/
  UPDATE/movimiento de fila cruzados bloqueados incluso con identidad miembro de ambos tenants.
  Una función SECURITY DEFINER intencionadamente sin filtro sigue limitada por RLS.
  Audit permite reconstruir dos cambios consecutivos de role/active y vínculo, además de ambas
  partes de la transferencia OWNER; replay no duplica evidencia.
  **102 comprobaciones de integración real PASS**: Auth/GoTrue, JWT, PostgREST, Storage,
  concurrencia, revocación y rollback; reconstrucción audit por REST sin leer la entidad actual.
  Stack local efímero y datos sintéticos; contenedores destruidos al finalizar.
- [CI general, run 35729889498](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35729889498): PASS,
  21 tests, typecheck, lint, build, shell y whitespace.
- Fallos intermedios resueltos: permiso CREATE temporal para cambiar propietario del trigger;
  USAGE de extensions concedido al writer solo dentro de la transacción de fixtures pgTAP y
  revertido con ROLLBACK. El primer intento del run final falló antes de tests por puerto 54324
  ocupado en el runner; el segundo completó toda la validación sin cambiar código ni omitir tests.
El commit posterior solo registra estas evidencias. Los Checks del PR muestran además la nueva
validación automática sobre ese último commit. H1 aprobado e integrado posteriormente por autorización expresa del usuario; H2 se autorizó después.

## HITO 2 — motor horario
ESTADO: PASS — HITO 2 aprobado por el usuario y PR #5 integrado en `main`.
Rama `astra/hito-2-motor-horario`, base `4ce37bda1e02124def77e0c6e89e2d069e65df21`.
PR [#5](https://github.com/marioleongayo23-spec/fichaje/pull/5) integrado en `main`. H3 no estaba iniciado al cierre de H2.

Entregado: work_policies/asignaciones append-only, employee_state con alta/backfill atómicos,
work_sessions/time_events inmutables, record_time_event y consulta operativa de estado.
Cinco transiciones legales, salida desde WORKING/PAUSED sin BREAK_END sintético, múltiples
sesiones, secuencia/versionado por empleado, política/zona fijadas por sesión y reloj efectivo
muestreado una sola vez tras el lock. Idempotencia persistente, auditoría y proyección atómicas.
Sin cierres automáticos; sesiones abiertas indican OPEN_SESSION sin inventar totales.

Continuación desde `a75f7c7fa7704f87d642d004884195e084918d68`, misma rama y PR:
- El 403 prematuro provenía de usar authorize/member_scope de H1, reservado a gestores.
  Migración aditiva con fichaje_clock y capability clock por tenant/empleado/principal/xid/backend.
  El EMPLOYEE válido sin política recibe ahora **400 POLICY_REQUIRED** sin escrituras parciales.
- Gates/capabilities y mutaciones H1 conservados. No se amplía el writer administrativo.
  Nuevo rol sin LOGIN/BYPASSRLS/herencia ni escritura de identidad; RLS/FORCE y grants mínimos.
  fichaje_state_reader solo consulta estado propio o autorizado a gestores.
- Orden: bind una vez → lock organización compartido con H1 → revalidación de acceso →
  lock employee_state → replay/máquina/reloj/escrituras. No repetir limpieza de contextos
  bajo el lock de organización. La primera revisión falló RACE-01; corregido y revalidado.
- Desactivar empleado o membresía impide fichajes y replay; el empleado inactivo con
  membresía activa conserva lectura autorizada de su estado.

Evidencia real del código `4819abb0c4122d5d76582bad4615753667dd6e1d`, 2026-09-22:
- [Database H1 + H2, run 35741052549](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35741052549): PASS.
  Ubuntu 24.04, Supabase CLI 2.117.0, stack local PostgreSQL 17/Auth/REST/Storage.
  `supabase db reset --local --no-seed` aplica las cuatro migraciones desde vacío.
  `supabase test db`: **180 pruebas SQL/pgTAP PASS** (106 H1, 43 motor H2, 31 capability H2).
  `python3 tests/integration/h2.py`: **102 checks H1 + 70 checks H2 PASS**,
  con login GoTrue real y JWT contra PostgREST/Storage, sin mocks de RLS.
  Contenedores destruidos al finalizar con `supabase stop --no-backup`.
- [CI general, run 35741052373](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35741052373): PASS.
  npm ci, typecheck, lint, **21 tests**, build, sintaxis shell y whitespace.
- El commit posterior únicamente registra esta evidencia. Ver Checks del PR para la
  ejecución automática adicional sobre ese commit documental; no modifica código probado.

Cobertura de salida H2:
| Criterio | Evidencia |
|---|---|
| STATE-01 | Las 12 celdas por RPC real: 5 legales y 7 rechazadas sin efectos; salida pausada preserva originales |
| TIME-01..05 | Hora cliente rechazada; muestra posterior al lock; medianoche y DST Madrid/Canarias en SQL; igualdad; regresión sin escrituras |
| IDEM-01..04 | 20 requests iguales, un evento/recibo/audit; payload distinto rechazado; timeout tras commit recupera recibo; revocado no puede replay |
| RACE-01..04 | 20 altas simultáneas, una proyección; 20 UUID distintos/misma versión: 1 éxito y 19 VERSION_CONFLICT; revocación gana lock; sin deadlocks |
| ATOM-01 | Fallo forzado de audit revierte evento, proyección, sesión y recibo; reintento tras rollback válido |
| IMM-01 | UPDATE/DELETE/TRUNCATE denegados a cliente y roles técnicos; triggers mantienen inmutabilidad aun con grants accidentales |
| Aislamiento | Cruces tenant/empleado/RPC/join/UUID denegados; GUC falsa no autoriza; clock no puede adquirir scope administrativo ni modificar identidad |

Límites: solo datos sintéticos y stack CI efímero. El entorno de edición no tiene Docker/PostgreSQL;
no se afirma ejecución DB local aquí. DST/igualdad usan fixtures SQL privilegiadas revertidas y
guard real, sin sustituir reloj/RPC. Timeout usa proxy local que pierde el ACK tras commit real.
Serialización conservadora por tenant, documentada. No H3, kiosco, informes H5, UI/PWA,
producción, datos reales ni configuración remota. Backup DB sigue bloqueado.

## OPS-02 — observabilidad y resiliencia (especificación original)
Requisito aprobado por el usuario para ejecutar después de H6 y antes de H7. Queda incorporado al roadmap como puerta obligatoria de producción: telemetría segura, health checks, canaries sintéticos, invariantes read-only, alertas, retries idempotentes, rollback de release y reconstrucción limitada de proyecciones reconstruibles. Regla absoluta: ninguna automatización o IA modifica `time_events`, correcciones aprobadas ni historia laboral. Estado actual: OPS-02 PASS, aprobado expresamente por el usuario e integrado en `main` mediante PR #12 (rama `astra/ops-02-observabilidad-resiliencia`, merge `f43af0d72a1e88cf14cc71a228e1677252dfe16f`; ver la sección OPS-02 al inicio de este documento), con SEC-OPS-01 resuelto.

## Siguiente paso
HITO 6 y OPS-02 aprobados y cerrados. OPS-02 (bloque obligatorio después de H6 y antes de H7) está integrado en `main` mediante PR #12 (merge `f43af0d72a1e88cf14cc71a228e1677252dfe16f`), con SEC-OPS-01 resuelto. HITO 7 sigue SIN iniciar: ya no está bloqueado por OPS-02, pero no se inicia sin una autorización expresa y posterior del usuario. Hasta entonces no hay producción, staging, DNS, secretos ni datos reales configurados, y el backup PostgreSQL real sigue `NOT_CONFIGURED` y bloqueado hasta H7.

## HITO 3 — correcciones append-only
ESTADO: PASS — HITO 3 aprobado por el usuario y PR #7 integrado en `main`.
Rama `astra/hito-3-correcciones`; [PR #7](https://github.com/marioleongayo23-spec/fichaje/pull/7) integrado en `main`.
Base H2 y actualización documental OPS-02 conservada.

Entregado: correction_requests, correction_decisions y event_adjustments append-only;
RPC submit_correction/decide_correction y lectura del timeline efectivo. ADD/REPLACE/VOID,
cadenas por referencia/supersedes, motivo acotado, base_version y decisión única.
Originales inmutables; effective_at separado de server_at, ordinal explícito y corte histórico.
Replay completo valida transiciones, sesiones, orden, intervalos, solapamientos y tiempos futuros.
Aprobación reconstruye proyección e incrementa versión; rechazo no modifica timeline.
Auditoría, idempotencia persistente y cambios se confirman o revierten juntos.

Independencia: otro OWNER/ADMIN autorizado; solicitante y gestor afectado no pueden decidir.
Se comprueban vínculo actual, vínculo al solicitar y autor original para impedir bypass por
desvinculación. Sin excepción para empresas de un único gestor. Capacidad H3 aislada por
tenant/empleado/principal/transacción; RLS/FORCE, referencias compuestas y grants mínimos.
Locks compartidos con H1/H2 y permisos revalidados tras el lock. H1/H2 no reciben nuevas
capabilities; adaptación mínima del guard del reloj H2 conserva el máximo server_at original
aunque el timeline corregido retroceda o quede vacío. Se separa la secuencia original de la
proyección efectiva; el test TRUNCATE H2 incluye la nueva tabla referenciante, sin relajar el trigger.

Evidencia real del código `cbd207263fa61b4d26e1cfe745630d01a8287540`, 2026-09-23:
- [Database H1 + H2 + H3, run 35814742001](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35814742001): PASS.
  Supabase local efímero en CI, PostgreSQL real; `supabase db reset --local --no-seed`
  reconstruye desde vacío. **217 pruebas SQL/pgTAP PASS** (180 anteriores + 37 H3).
  **102 checks H1 + 70 H2 + 80 H3 PASS** con GoTrue/JWT/PostgREST/Storage reales.
  Contenedores destruidos con `supabase stop --no-backup`.
- [CI general, run 35814741994](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35814741994): PASS.
  Instalación, typecheck, lint, **21 tests**, build, sintaxis shell y whitespace.
- `npm run check`, `python3 -m py_compile tests/integration/h3.py`,
  `bash -n scripts/*.sh` y `git diff --check`: PASS en el entorno de edición.
  Sin Docker/PostgreSQL en este entorno; no se atribuye aquí la ejecución DB de CI.

| Criterio | Evidencia real |
|---|---|
| COR-01 | ADD/REPLACE/VOID válidos, cadenas sucesivas, rechazo sin ajustes, una decisión y replay idempotente |
| COR-02 | Solicitante/afectado/EMPLOYEE/gestor cruzado denegados; independencia tras desvincular; OWNER revisado por ADMIN independiente |
| COR-03 | Base obsoleta rechazada en aprobación/rechazo; 20 propuestas de una base dejan un ganador; carrera H2/H3 comparte versión |
| COR-04 | Replay imposible, intervalo negativo, solapamiento, futuro y empate sin ordinal válido rechazados sin efectos |
| COR-05 | Timeline/proyección/versión atómicos; fallo audit revierte decisión, ajustes, sesión, proyección y recibo; reintento válido |
| COR-06 | Originales idénticos antes/después; fuente/autor y server_at preservados; effective_at separado y lectura histórica |

Cobertura adicional: referencias a evento/sesión/ajuste de otro tenant denegadas, lectura
propia/gestor/anon y DML directo, grants técnicos negativos, 20 solicitudes y 20 decisiones
idénticas sin duplicados, revocación concurrente y bloqueo de replay con JWT revocado.
Fallos intermedios corregidos y revalidados: sintaxis SQL, fixture TRUNCATE con nueva FK,
mapeo HTTP de conflictos H3 y fixture PATCH con payload/filtro explícitos. Ningún test omitido
ni simulación de lógica SQL. El commit documental posterior registra esta evidencia; sus
Checks ejecutan de nuevo toda la suite sin cambiar el código probado.

Límites: datos exclusivamente sintéticos y stack CI efímero. Sin UI/PWA, kiosco H4, informes H5,
clasificaciones de horas, producción, datos reales ni configuración remota. Backup DB bloqueado.
PR #7 integrado por autorización expresa del usuario. H4 autorizado posteriormente; ver sección siguiente.



## HITO 4 — kiosco seguro
ESTADO: PASS — HITO 4 aprobado por el usuario, incluida SEC-H4-01, y PR #8 integrado en `main`.
Rama `astra/hito-4-kiosco`, base main `4d2a40d09be431fd1f8cafe1365c7b71b8b520bf`.
[PR #8](https://github.com/marioleongayo23-spec/fichaje/pull/8), integrado en `main`.

Entregado: cuatro tablas privadas FORCE RLS, identidades Auth técnicas con exclusión
bidireccional de memberships, provisioning/revocación OWNER/ADMIN y reset auditado.
Gateway Deno server-only valida JWT con GoTrue; SQL por login dedicado con únicamente
el rol gateway (EXECUTE de entrypoints, sin tablas ni service_role). Auth admin solo
para crear/compensar cuentas técnicas; no acceso universal a datos laborales.
PIN CSPRNG de ocho dígitos, Argon2id 19 MiB/t=2/p=1, salt individual de 16 bytes y
pepper externo de >=32 bytes. Entrega cifrada RSA-OAEP-256 al gestor; ningún PIN en claro
en respuestas, DB o logs. Reset conserva locks y revoca credencial/challenges anteriores.
Rate limit persistente por empleado y dispositivo, 5/30 fallos en 15 minutos, sin bypass
con PIN correcto y conservado tras reiniciar gateway. Errores externos genéricos y no-store.
Challenge de 256 bits, solo hash, TTL 60 s, ligado a tenant/empleado/dispositivo/acción/
versión/request_id. Consumo, evento, estado, audit KIOSK e idempotencia en una transacción.
Recuperación exacta tras perder ACK, sin nuevo fichaje, incluso tras caducar el challenge
consumido; siempre revalida dispositivo, empleado y versión de credencial.

H2/H3 comparten una única función invoker `private.apply_time_event`: misma máquina,
locks, política, reloj/high-water de originales, secuencia e inmutabilidad. Autorización
humana original conservada; kiosk tiene capabilities y RLS separadas. Sin acceso a
directorio, correcciones administrativas, memberships, roles o exports.

Evidencia real del código `b3fa80ed3c68fb9eda6ba24efaaf5ad43d934da8`, 2026-09-23:
- [Database H1 + H2 + H3 + H4, run 35839508363](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35839508363): PASS.
  Ubuntu 24.04, Deno 2.9.6, Supabase CLI 2.117.0, PostgreSQL 17, GoTrue/PostgREST/Storage
  reales. `supabase db reset --local --no-seed` reconstruye las seis migraciones desde vacío.
  **246 tests SQL/pgTAP PASS** (217 previos + 29 H4).
  **346 checks de integración PASS: 102 H1 + 70 H2 + 80 H3 + 94 H4**.
  Gateway HTTP real, sin mocks de RLS/Auth. Concurrencia, revocación con JWT previo y
  lock primero, 12 consumos simultáneos/un evento, payload distinto, ACK perdido por
  proxy tras commit real, rollback audit, matriz H2 completa por kiosco e inmutabilidad.
  Prueba KIO-07 escanea PIN sintéticos conocidos en memoria contra tablas serializadas,
  logs de contenedores/gateway/suite, respuestas HTTP y artefactos temporales generados:
  ninguna fuga en claro. Los buffers se imprimen solo después del gate.
  Stack destruido con `supabase stop --no-backup` al terminar.
- [CI general, run 35839508364](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35839508364): PASS.
  npm ci, typecheck, lint, **21 tests**, build, shell y whitespace.
- Entorno de edición: `npm run check`, Deno strict check, Python compile y diff check PASS.
  No Docker/PostgreSQL local: la ejecución DB/Auth atribuida aquí es la de CI.
- Fallos intermedios corregidos: sonda de arranque demasiado corta para suelo de 300 ms;
  INHERIT de la membresía del login efímero PostgreSQL; doble serialización JSONB del
  driver. Provisioning concurrente compensa la cuenta Auth que no ganó. Ningún test omitido.
- El commit posterior solo registra esta evidencia. Sus Checks repiten automáticamente
  la suite; no cambia el código probado.

Límites: solo datos/secretos sintéticos efímeros. Gateway probado como módulo Deno por HTTP
con stack Supabase real local de CI; no despliegue Edge remoto ni producción. Entrega de
PIN es un contrato cifrado backend; interfaz y limpieza visual a 15 s corresponden a H6.
No fichaje offline, ACK optimista, informes/retención H5, UI/PWA H6, OPS-02 ni datos reales.
OPS-02 permanece después de H6 y antes de H7. Compensación de Auth en fallo de red es
best effort; identidades no vinculadas no obtienen acceso tenant y deben reconciliarse
antes del piloto. Backup DB sigue bloqueado. HITO 4 cerrado; H5 no iniciado.

## Revisión SEC-H4-01 (aprobada e integrada)
En la misma rama astra/hito-4-kiosco y PR #8. Defensa adicional por peer TCP
normalizado y HMAC tenant con secreto backend independiente; bucket persistente
60/15 min, sin cambios H1/H2/H3 ni límites empleado/dispositivo. Frontera de
confianza y proxy documentadas. KIO-07 ampliado para IP y digests.
Estado de esta revisión: **PASS; HITO 4 y SEC-H4-01 aprobados e integrados en main**.
Evidencia del código `a820a417d03b543ebb8ff7470cffc0ee3e07c755`:
- [Database run 35869927438](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35869927438): PASS, Supabase/PostgreSQL/Auth reales, reset desde vacío sin seed; **251 SQL/pgTAP**, **356 checks integración (102 H1 + 70 H2 + 80 H3 + 104 H4)**. Gateway strict typecheck y **2 tests Deno** PASS. Ninguna suite omitida.
- [CI run 35869927465](https://github.com/marioleongayo23-spec/fichaje/actions/runs/35869927465): PASS; npm ci, typecheck, lint, **21 tests**, build, shell y whitespace.
- SEC-H4-01: 60 fallos reales desde un peer TCP sintético repartidos entre tres dispositivos, headers falsificados sin alterar el bucket, bloqueo persistente tras reinicio y frente a PIN correcto, separación por peer/tenant, expiración servidor, RLS y contadores previos conservados.
- KIO-07: PIN/IP sintéticos ausentes de DB/logs/respuestas/artefactos; todos los digests de red ausentes de logs/respuestas/artefactos/audit laboral. Solo HMAC en tabla privada. Captura y escaneo en memoria antes de imprimir resultados.
- Verificación local: npm run check, Deno check/test, Python compile, shell y whitespace PASS. DB/Auth se ejecutaron en CI, no se simularon localmente.
Este commit documental registra la evidencia anterior y no cambia código probado.
PR #8 integrado por autorización expresa del usuario. Sin iniciar H5 ni OPS-02; sin producción, secretos reales ni datos reales. OPS-02 permanece después de H6 y antes de H7. Trabajo detenido.

## HITO 5 — aprobado e integrado
ESTADO: PASS. HITO 5 aprobado por el usuario e integrado en `main` mediante PR #9.

Entregado: snapshot materializado consistente; exportación privada determinista CSV/JSON/PDF;
clasificaciones append-only; entrega controlada con recibo; purga laboral y operativa mediante
proceso offline mínimo; holds append-only; manifiestos transaccionales; journal PostgreSQL separado
de bajas, holds, liberaciones y purgas; y replay idempotente después de restore.

Evidencia final del código `4ee30b5f43828d7076eba9252f9779c58c392c89`, 2026-09-25:
- [Database H1 + H2 + H3 + H4 + H5, run 36149687175](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36149687175): PASS.
  Supabase local efímero reconstruido desde vacío, PostgreSQL 17, Auth, PostgREST y Storage reales.
  **297 aserciones SQL/pgTAP PASS**, **4 tests de generación CSV/JSON/PDF/DST PASS** y
  **429 checks de integración PASS: 356 H1-H4 + 73 H5**. Sin tests omitidos.
- H5 prueba transacciones PostgreSQL concurrentes: una corrección aprobada durante la generación
  conserva un paquete íntegramente anterior al cutoff, nunca híbrido. Prueba Auth y RLS de empleado,
  OWNER/ADMIN, kiosco y cross-tenant; Storage privado, URL firmada y expirada, revocación y TTL.
- Purga laboral real leaf-first sin CASCADE, plazo exacto y ampliación por correcciones, sesiones
  incompletas bloqueadas, receipts conservados, holds de organización/empleado, counts/digest y
  rollback completo ante fallos forzados de audit, manifest, Storage y journal.
- Restore sintético real: `pg_dump`, cambios posteriores, `pg_restore` sobre PostgreSQL y replay del
  journal externo. Verifica bajas, holds/liberaciones, tombstones, RLS, idempotencia y otro tenant intacto.
- [CI general, run 36149687094](https://github.com/marioleongayo23-spec/fichaje/actions/runs/36149687094): PASS.
  Typecheck, lint, **21 tests**, build, shell y whitespace.
- Verificación local final: `npm run check`, Python compile, shell y `git diff --check` PASS.

Todo usa datos y credenciales exclusivamente sintéticos y efímeros. No hay producción, backup DB real,
datos/secretos reales, UI/PWA, H6 ni OPS-02. OPS-02 permanece después de H6 y antes de H7.
