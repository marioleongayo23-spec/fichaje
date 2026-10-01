# CURRENT_STATE — 2026-10-01

## PREPROD-01 — puerta previa al primer cliente real / producción

**ESTADO ACTUAL: BLOCKED / EN EJECUCIÓN.** HITO 7 está cerrado. PREPROD-01 se ha iniciado por autorización del usuario, autoriza configurar y desplegar el candidato productivo exclusivamente sintético. No autoriza clientes/datos reales, gasto ni merge.

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/preprod-01-primer-cliente`  
PR: #16 — OPEN  
Contrato de puerta: `docs/PRODUCTION_GATE.md`

### Estado inicial PRE-01..10

- PRE-01 normativa/convenio: PARTIAL — base estatal y AEPD revisadas el 2026-10-01; el convenio se valida por cliente concreto.
- PRE-02 paquete legal/comercial: PARTIAL — DPA/subencargados principales verificados; faltan identidad contractual de Fichaje, proveedores pendientes, marcadores y revisión jurídica independiente antes de datos reales.
- PRE-03 producción aislada: PARTIAL — Supabase `Fichaje APP` está `ACTIVE_HEALTHY` en `eu-west-1`; 17/17 migraciones del repo aplicadas y su historial corregido para coincidir exactamente con los timestamps de Git; bucket `fichaje-evidence` privado creado. Sigue con 0 usuarios Auth, 0 organizaciones, 0 empleados, 0 fichajes y 0 objetos Storage. Edge Functions/secretos/Auth productivos y Cloudflare productivo aún pendientes.
- PRE-04 dominio/borde: BLOCKED — Pages productivo puede ser 0 €, pero no hay dominio propio; WAF/rate limits de zona requieren ese dominio.
- PRE-05 correo transaccional: PARTIAL — Brevo Free seleccionado como candidato 0 €; pendiente dominio, DPA/alta, SPF/DKIM/DMARC y prueba real.
- PRE-06 alertas reales: PARTIAL — PagerDuty Free + GitHub Issues seleccionados como rutas 0 €; cuentas/tokens y prueba real aún no activados.
- PRE-07 backup/restore real: BLOCKED — Free exige exportación externa; falta host de operación fiable para backup diario cifrado. Ensayo remoto sintético puede hacerse aparte, pero no sustituye operación diaria.
- PRE-08 seguridad independiente: PARTIAL — Supabase Advisor sin hallazgos críticos nuevos; 20 SECURITY DEFINER intencionales y HIBP Pro-only documentados. Falta revisión externa/independiente del candidato productivo.
- PRE-09 ensayo production-like: BLOCKED — se ejecutará sin datos reales cuando exista entorno candidato.
- PRE-10 primer cliente: BLOCKED — requiere empresa concreta, convenio, contratos y autorización expresa posterior.


### Verificación de continuidad PREPROD-01 — 2026-10-01

- HEAD inicial verificado: `52f345cdd47b72f0b6ea3ac3172b16a3acc23571`; sus cinco workflows están completed/success.
- Supabase candidato `bypdviatamosygndeqhh`: ACTIVE_HEALTHY, eu-west-1; historial de 17 migraciones coincide con Git. Recuento real: 0 usuarios Auth, organizaciones, empleados, fichajes y objetos Storage.
- RLS + FORCE RLS en todas las tablas public/private. Anon: 0 permisos de tablas y 0 SECURITY DEFINER de negocio ejecutables. Gateway: 0 permisos de tablas, únicamente cinco entrypoints privados. Export worker: solo SELECT directo de export_jobs, sin escritura ni lectura directa de eventos.
- Roles gateway/export/monitor: NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEROLE y NOBYPASSRLS. SET LOCAL ROLE probado en transacciones remotas revertidas, con acceso directo a empleados/estado/eventos denegado.
- Advisor productivo: 20 avisos SECURITY DEFINER intencionales; no son una auditoría independiente. No revocar ni ampliar permisos mecánicamente.
- Comparación de todos los archivos desplegados: export-link v3 coincide byte a byte con el HEAD inicial; kiosk v4 difiere en index.ts. No afirmar correspondencia de release hasta redesplegar y volver a comparar.
- Defecto detectado en el HEAD inicial: authenticate y record abrían db.begin sin SET LOCAL ROLE. Se corrigen para usar gatewayTx. La integración H4 incorpora guards de prueba dentro de las dos funciones SQL reales que rechazan llamadas sin role=fichaje_gateway; las suites Auth/PIN/challenge/fichaje existentes ejercitan esas rutas.
- Ingress remoto sin firma: GET de health/live y health/ready de ambas funciones devuelve 403 y no-store. Esta evidencia no prueba secretos exclusivos, FICHAJE_ENV, readiness firmada ni el frontend productivo.
- Cloudflare: el navegador permanece en verificación de seguridad tras una recarga; no se creó ni desplegó Pages productivo.
- Gestión de secretos Supabase: apertura rechazada por revisión automática de permisos; el conector no expone configuración de secretos/Auth. No se han leído valores ni rotado/configurado secretos por esta sesión.
- Journal `fichaje_recovery`: no existe. Sin host/destino/custodia/journal no hay backup diario ni restore del candidato; RPO/RTO productivos no medidos.
- Todos los controles siguen PARTIAL/BLOCKED. PRE-09 no ejecutado; PRE-10 requiere cliente, contratos y autorización posterior.
- La corrección debe superar CI, Database, E2E H6, OPS-02 y H7 del mismo HEAD antes de desplegar. La evidencia final vinculante son los runs del HEAD actual del PR #16; los PASS del HEAD inicial no validan un commit posterior.
- Sin datos reales, gasto, nuevo hito/rama/PR ni merge.

### Política de coste

0 € mientras sea compatible con la puerta. No contratar dominio, SMTP, plan Pro, segundo entorno, backup gestionado ni revisión profesional sin autorización expresa y justificación.

### HITO 7

## HITO 7 — aprobado e integrado

**ESTADO ACTUAL: PASS.** HITO 7 fue aprobado expresamente por el usuario el 2026-10-01 e integrado en `main` mediante PR #15.

Repositorio: `marioleongayo23-spec/fichaje`  
Rama histórica: `astra/hito-7-piloto-comercial`  
PR: #15 — MERGED  
HEAD final del PR validado: `137e4ab4d813585b3a4663e0dd9bac5bbc12be0c`  
Merge commit en `main`: `01c80f3afc34bb602f28c90be1ae096fd073b81e`

### Gates del HEAD validado

Los cinco workflows obligatorios terminaron `completed/success` sobre el mismo HEAD:

- CI: run `36830693034`.
- Database H1 + H2 + H3 + H4 + KIO-H6-01 + H5: run `36830692909`.
- E2E H6: run `36830692919`.
- OPS-02: run `36830692714`.
- H7: run `36830692776`.

El HEAD final del PR solo añadió la evidencia consolidada de `CURRENT_STATE.md` sobre el código desplegado y validado `98e814ffafc32b3fa8c892908fbcbff97e58fc42`; los cinco gates volvieron a terminar PASS. No se añadieron secretos ni datos reales.

### Staging desplegado

Cloudflare Pages: proyecto `fichaje-staging`.  
Deployment final: `5afeab10`, marcado como Latest production deployment del proyecto de staging.  
Alias estable: `https://fichaje-staging.pages.dev/`.  
Release servido por el alias: `98e814ffafc32b3fa8c892908fbcbff97e58fc42`.

La portada desplegada muestra la aplicación real: login, alta de empresa y alta para aceptar invitaciones. Ya no aparece el fallback de configuración pública ausente.

El término “Production” de Cloudflare se refiere únicamente al environment interno del proyecto **fichaje-staging**. No existe activación de Fichaje APP/producción ni cliente real.

### Supabase staging

Proyecto existente: `fichaje-staging`, ref `pvfjffeszsedslmwdvgh`, región UE, ACTIVE_HEALTHY.

Migraciones aplicadas hasta `20260930000200_export_generation.sql`.  
Edge Functions `kiosk` y `export-link` desplegadas y protegidas por el ingress firmado existente.  
No se creó infraestructura adicional, plan de pago ni un proyecto por cliente.

### Fichaje Demo

Organización ficticia estable: **Fichaje Demo**.  
Organization ID: `fb9c2b0e-f71d-4bb4-a6aa-44ea110e56eb`.

La validación remota acumulada cubre:

- identidades sintéticas OWNER, ADMIN y EMPLOYEE;
- empleado sin email mediante kiosco;
- horario Europe/Madrid;
- CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT por kiosco;
- ciclo completo WEB;
- consulta del registro;
- solicitud de corrección y aprobación por un ADMIN independiente;
- originales inmutables y ajuste append-only;
- onboarding de empresa desde la app;
- invitaciones y aceptación;
- aislamiento multiempresa;
- replay/idempotencia;
- SEC-H4-01;
- exportación final desde la UI.

La evidencia remota previa de `verify_staging.py` se conserva: **33 PASS / 0 FAIL / 0 SKIPPED**. También se conserva la verificación remota de aislamiento y SEC-H4-01.

### Exportación final — bloqueo resuelto

El bloqueo anterior era un job histórico que quedó `PENDING` cuando staging no tenía generación server-side.

Tras integrar la generación segura en `export-link` y desplegar el build final, se ejecutó un recorrido real desde la UI con una sesión ADMIN sintética de Fichaje Demo:

- alcance: Toda la organización;
- periodo: 2026-09-30 a 2026-09-30;
- zona: Europe/Madrid;
- la UI mostró `Paquete preparado`;
- estado visible: `Lista para descargar`;
- un único clic en `Descargar`;
- la UI confirmó `Descarga iniciada. El enlace caduca en unos minutos y no se guarda.`;
- PostgreSQL dejó el job nuevo `900f725d-3eca-4be1-8456-5592ed36cc5e` en `READY`, con checksum y ruta privada de objeto ZIP.

El navegador de automatización no permite reabrir el historial de descargas ni desempaquetar el ZIP remoto en una sesión posterior. No se afirma una inspección byte a byte que no se pudo observar. La puerta H7 vigente exige exportación real desde la UI, que sí quedó verificada; la estructura CSV/JSON/PDF/manifest y el renderer permanecen cubiertos por las suites H5/H7 del mismo HEAD.

### Seguridad y coste

- Sin datos reales.
- Sin clientes reales.
- Sin secretos en GitHub.
- Sin producción.
- Sin Supabase Pro ni nueva infraestructura de pago.
- Arquitectura multiempresa compartida: no se crea un Supabase de pago por cliente.
- RLS + `organization_id` siguen siendo la frontera de aislamiento.
- Los originales permanecen inmutables; las correcciones siguen siendo append-only.

### Hitos anteriores

HITO 0, OPS-01, HITO 1, HITO 2, HITO 3, HITO 4, HITO 5, HITO 6, OPS-02 y HITO 7 están aprobados e integrados en `main`.

El detalle histórico completo permanece en el historial Git y en `docs/`; este archivo queda deliberadamente reducido al estado operativo actual.

### HITO 7 cerrado

No quedan tareas pendientes dentro de HITO 7.

La siguiente fase es una puerta separada previa al primer cliente real / producción: alertas reales, estrategia de backup/restore definitiva, respuesta a incidentes, revisión legal/seguridad y autorización expresa de producción. No se inicia por este merge y cualquier gasto futuro requiere autorización expresa.
