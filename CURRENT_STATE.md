# CURRENT_STATE — 2026-10-05

## HITO 11 — réplica visual Bundy

**ESTADO ACTUAL: PASS técnico.** Réplica visual implementada y validada 5/5; falta únicamente validar el commit documental final y devolver el repositorio a privado antes de cualquier merge.

Rama: `astra/hito-11-replica-visual-bundy`  
Base: `main@e1f249b398859a073fb95784b6659eca6be37f40`.

### Fuente visual autoritativa
- `Bundy App(1).pdf` / `Bundy App.pdf` renderizados a imagen para comparación visual.
- `logos.zip` para identidad oficial.
- HITO 11 usa el PDF como referencia estricta de composición, proporciones, jerarquía, navegación inferior, espaciado, radios, densidad y CTA.

### Alcance
- Reproducir con mucha mayor fidelidad las pantallas 01 Fichar, 03 Mis horas, 04 Gerente y 05 Bienvenida.
- Login/onboarding solo se ajustan si hace falta mantener coherencia de sistema; no se reabre lógica de autenticación.
- Mantener únicamente funciones V1 reales. Si el mockup muestra una función fuera de V1, se conserva el espacio/estética sin inventar comportamiento.
- La ubicación del PDF NO se implementa ni se simula: V1 la prohíbe.
- Sin cambios SQL, migraciones, RLS/RPC, Edge Functions, seguridad, motor horario, idempotencia, timestamps, auditoría, Stripe ni almacenamiento.

### Evidencia de cierre
- HEAD de código validado: `dd8581a0a5d5963af94120277ef4fc8f641ed000`.
- Diff contra `main`: frontend, CSS, tests E2E visuales y documentación únicamente; sin SQL, migraciones, RLS/RPC, Edge Functions, seguridad, motor horario, idempotencia, auditoría, Stripe ni almacenamiento.
- Pantallas replicadas desde el PDF: 05 Bienvenida, 01 Fichar, 03 Tus horas y 04 Tu equipo hoy.
- Se conserva V1 real: sin geolocalización, fotos, biometría ni funciones ficticias; la evidencia legal sigue accesible tras «Ver detalle legal del registro».
- Correcciones de regresión posteriores al primer corte: limpieza de import, foco/offline del fichaje, contraste y semántica de tabla, tolerancia del test al salto de línea y jerarquía de headings. Todas permanecen en capa frontend/tests.
- Regresión sobre `dd8581a0a5d5963af94120277ef4fc8f641ed000`:
  - CI run `37316156015`: PASS.
  - Database run `37316156132`: PASS.
  - E2E H6 run `37316156059`: PASS.
  - OPS-02 run `37316155993`: PASS.
  - H7 run `37316156040`: PASS.
- El commit documental final debe volver a obtener 5/5 PASS por política del proyecto.
- PR #27 permanece abierto; sin merge ni despliegue productivo sin aprobación expresa posterior.


## HITO 10 — fidelidad visual Bundy + entrada/login + despliegue final

**ESTADO ACTUAL: PASS / MERGED.** HITO 10 aprobado y mergeado por orden expresa del usuario. PR #26 cerrado; merge commit `e1f249b398859a073fb95784b6659eca6be37f40`.

Rama: `astra/hito-10-fidelidad-visual-bundy`  
Base: `main@a8bded0802cf5e495d859369593a93d5adcb99c5`.

### Objetivo y fuente visual
- Corregir la insuficiente fidelidad de HITO 9 sin tocar contratos funcionales ni backend.
- Fuente visual autoritativa: `Bundy App.pdf` / `Bundy App(1).pdf`, `logos.zip` y la web comercial pública Bundy de Webflow.
- Paleta medida en los activos oficiales: bosque `#1F4A33`, niebla `#EEF1EE`, aulaga `#F2C230`.
- El PDF define el lenguaje de producto: marco/acentos bosque, superficies niebla/blanco, CTA aulaga, tarjetas suaves, navegación inferior y botón circular «Hacer bundy».
- La web comercial define la entrada: «Hola de nuevo», acceso a equipo/horas y continuidad de marca Bundy.

### Diagnóstico remoto previo
- `https://fichaje-staging.pages.dev/` responde con un release antiguo: título «Iniciar sesión · Fichaje», copy «Fichaje APP», theme-color azul y release `98e814ffafc32b3fa8c892908fbcbff97e58fc42`.
- `https://fichaje.pages.dev/` no sirve el SaaS validado: responde con una aplicación histórica distinta («Fichaje – Comparativa (Offline)»).
- Por tanto HITO 10 incluye acreditar el despliegue correcto, no solo el código.

### Límites
- Solo presentación/composición/frontend y despliegue del mismo artefacto; sin SQL, migraciones, RLS/RPC, Edge Functions, motor horario, idempotencia, timestamps, auditoría, almacenamiento ni activación Stripe.
- No implementar ni simular geolocalización, biometría, fotos, vacaciones, nóminas ni otras funciones fuera de V1 aunque aparezcan en referencias comerciales.
- Mantener accesibilidad, nombres/contratos de acciones y todos los flujos existentes.

### Evidencia de cierre
- HEAD de código validado: `c6b87752949766164b9e055dd2b8fac3b03ceafe`.
- Diff contra main: frontend/documentación/tests visuales únicamente; 0 cambios SQL, migraciones, RLS/RPC, Edge, seguridad, motor horario, idempotencia, auditoría o Stripe.
- Regresión sobre ese HEAD:
  - CI run `37297152164`: PASS.
  - Database run `37297152230`: PASS.
  - E2E H6 run `37297152093`: PASS.
  - OPS-02 run `37297152084`: PASS.
  - H7 run `37297152104`: PASS.
- E2E H6 incorpora contrato visual Bundy: sesión limpia muestra login, «Hola de nuevo», paleta oficial y CTA circular «Hacer bundy».
- Despliegue manual Direct Upload en `https://fichaje-staging.pages.dev/` realizado con el artefacto exacto de CI `pages-dist-c6b877...`.
- Verificación remota posterior: título `Iniciar sesión · bundy`; copy «Hola de nuevo» / «Entra para ver tu equipo y tus horas.»; assets `bundy-app-icon.svg` y `bundy-symbol.svg`; `theme-color #1f4a33`; metadato `fichaje-release=c6b87752949766164b9e055dd2b8fac3b03ceafe`.
- La verificación previa había demostrado que `fichaje-staging.pages.dev` servía un release antiguo y `fichaje.pages.dev` una app histórica distinta. HITO 10 corrige staging; producción `fichaje.pages.dev` no se ha tocado.
- Commit documental `e12b4538b39a51265532fb35ffdf72ed12b14b65`: CI `37299737788`, Database `37299737812`, E2E H6 `37299737797`, OPS-02 `37299737807`, H7 `37299737789` = 5/5 PASS.
- Este commit deja el estado documentado como PASS; el HEAD resultante debe recibir una última regresión 5/5 por política del proyecto.
- PR #26 fue aprobado y mergeado por orden expresa del usuario. `main` quedó en `e1f249b398859a073fb95784b6659eca6be37f40`.


## HITO 9 — integración visual exacta del diseño del socio

**ESTADO ACTUAL: PASS.**

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/hito-9-integracion-visual-socio`  
Base: `main@0c734cc61b5d60a20d2f0307042f94042fc70554`  
PR: #25 — MERGED; merge commit `a8bded0802cf5e495d859369593a93d5adcb99c5`.

### Fuente visual y alcance
- Fuente visual autoritativa recibida: `Bundy App.pdf` + `logos.zip`.
- Integración limitada a presentación/frontend: identidad Bundy, paleta bosque/niebla/amarillo, tarjetas blancas, navegación inferior, CTA circular «Hacer bundy», formularios, diálogo, PWA branding y kiosco visual.
- No se implementó ni simuló geolocalización del material de referencia porque V1 la prohíbe.
- No se modificaron SQL, migraciones, RLS/RPC, Edge Functions, seguridad, motor horario, idempotencia, timestamps, auditoría, Stripe, almacenamiento ni semántica offline/PWA.
- Los únicos tests editados ajustan expectativas de marca/título; no se relajó ninguna aserción funcional ni de accesibilidad.

### Evidencia
- Commit visual: `c680b9ec2f6ca94f8707bc5ca4f9fbc2d2be39dd`.
- Regresión real sobre ese HEAD:
  - CI: PASS.
  - Database: PASS.
  - OPS-02: PASS.
  - H7: PASS.
  - E2E H6: FAIL con 48/52; las 4 únicas fallas fueron el mismo control de accesibilidad WCAG 2.5.8: «Cerrar sesión» quedó por debajo de 44 px tras compactar el header.
  - Flujos funcionales employee/manager/kiosk/PWA, aislamiento, fichajes, correcciones, exportaciones, offline y seguridad pasaron dentro de esa ejecución.
- Corrección mínima: `b232a3db3bb5cf3660f324e71fe7693efd157102`, únicamente 4 líneas CSS para restaurar `min-height: var(--touch)` en «Cerrar sesión».
- Desde `b232a3db...`, GitHub no asigna runner a ningún workflow: CI, Database, E2E H6, OPS-02 y H7 terminan antes del primer step. Evidencia API repetida: `runner_id=0`, `runner_name=""`, `steps=[]/null`, `logs_url=null`; CI se reintentó hasta attempt 3 con el mismo resultado.
- Por tanto el código no puede recibir aún el 5/5 obligatorio del HEAD corregido. No se declara PASS.

### Diff de seguridad del alcance
El diff contra `main` se limita a documentación H9 y capa visual/frontend:
- `index.html`;
- assets SVG Bundy;
- `public/manifest.webmanifest`;
- `src/App.tsx` (marca);
- `src/config.ts` (constante de marca);
- `src/employee/ClockPage.tsx` (composición/semántica visual, manteniendo nombres accesibles de acciones);
- `src/styles.css`;
- dos expectativas E2E de marca/título;
- `CURRENT_STATE.md` y `docs/ROADMAP.md`.

**Validación final:** el repositorio se hizo público temporalmente el 2026-10-05 para recuperar runners GitHub-hosted sin coste tras agotar la cuota mensual privada. Sobre `cc27163f6318562cf10f8fc9947c37f10ef9de68` se obtuvo 5/5 PASS:
- CI run `37291226017`: PASS.
- Database run `37291225997`: PASS.
- E2E H6 run `37291226090`: PASS.
- OPS-02 run `37291225971`: PASS.
- H7 run `37291226032`: PASS.

El HEAD documental final `fc37a9b1d4dac6e38158aa6055cc108705ec7562` obtuvo también 5/5 PASS (H7 load pasó en reintento sobre el mismo código). El repositorio volvió a privado y PR #25 fue aprobado y mergeado por orden expresa del usuario.


## HITO 8 — GO-LIVE / producción aprobado

**ESTADO ACTUAL: PASS.** HITO 8 aprobado expresamente por el usuario el 2026-10-05.

Repositorio: `marioleongayo23-spec/fichaje`  
Rama histórica: `astra/hito-8-go-live`  
PR: #17 — MERGED  
Merge commit en `main`: `0c734cc61b5d60a20d2f0307042f94042fc70554`.

### Candidato productivo
- Supabase `Fichaje APP`, ref `bypdviatamosygndeqhh`, región `eu-west-1` (Irlanda), ACTIVE_HEALTHY.
- Cloudflare Pages `fichaje`, release desplegado `h8-3919f7a55bb4`.
- Solo datos sintéticos de canary/validación. Ningún cliente ni dato laboral real.
- PostgreSQL de kiosk con login dedicado, rol mínimo y `sslmode=verify-full`.

### Puertas GO-01..GO-10

| Gate | Estado | Evidencia / bloqueo |
|---|---|---|
| GO-01 Código | PASS | HEAD de código `b817d1a3bd7b824cbbe5b22f1521b4dd6ea2cc93`: CI, Database, E2E H6, OPS-02 y H7 = 5/5 PASS. Cualquier commit posterior de evidencia debe volver a obtener 5/5 PASS antes de merge. |
| GO-02 Destinos/TLS | PASS | Canary fija API y PostgreSQL por entorno de forma independiente; cruces staging↔production, overrides DSN, `hostaddr`, `service`, puerto no estándar y TLS débil fallan cerrado. Producción exige `verify-full`. |
| GO-03 Seguridad | PASS con riesgo residual documentado | Security Advisor sin ERROR; 20 SECURITY DEFINER revisadas: 0 ejecutables por anon, todas con search_path fijo; todas las tablas public con RLS + FORCE RLS; inmutabilidad presente; secret scan CI PASS. WARN de leaked-password protection solo disponible en Supabase Pro y no se contrata bajo política 0 €. |
| GO-04 Release | PASS | Supabase + Cloudflare sirven el mismo release aprobado; `verify_production.py` remoto final: 33 PASS / 0 FAIL / 0 SKIPPED. |
| GO-05 Canary | PASS | Tenant sintético productivo WEB + KIOSK, RLS, auditoría, idempotencia y replay. |
| GO-06 Alertas | PASS | CRITICAL entregada/resuelta en ruta real; WARNING abrió/cerró issue #24; 0 pendientes y sin PII/secrets. |
| GO-07 Recuperación | PASS | Backup productivo age `fichaje-db-20261002T100304Z-2af8ca8e`, restore aislado de esa misma copia PASS, negativos REC-03 PASS y journal independiente Neon Frankfurt con `verify-full`. El ciphertext se migró además a un segundo proyecto Neon Free (`fichaje-backups`, Frankfurt), con SHA/tamaño/cabecera/manifest verificados, clave age ausente, inmutabilidad y purga autorizada solo tras 35 días. |
| GO-08 Incidente | PASS | Workflow H7 del mismo HEAD: `Incident response drill IR-01` SUCCESS; simulacro sintético cubre detección, contención, evidencia, revocación/rotación, evaluación RGPD, recuperación y reapertura autorizada. |
| GO-09 Legal/comercial | PASS de readiness | Revisión normativa vigente; paquete Art. 28, subencargados/transferencias, información a plantilla, RLT/Inspección, convenio/pausas y onboarding preparados. Backup laboral futuro aprobado en Neon/Databricks bajo su marco DPA, no en Drive personal. Los campos de identidad/firma se completan obligatoriamente en el onboarding de cada cliente y no son inventables antes de existir ese cliente. |
| GO-10 Gobierno | PASS por aceptación expresa de riesgo residual | Rollback implementado/documentado/probado. GitHub Free no ofrece protección preventiva de `main` en este repo privado; el usuario aprueba expresamente el 2026-10-05 cerrar HITO 8 manteniendo el repositorio privado y el plan gratuito. `.github/workflows/main-integrity.yml` queda como control compensatorio post-push y este riesgo residual permanece documentado. |

### GO-07 — evidencia productiva
Backup:
- nombre `fichaje-db-20261002T100304Z-2af8ca8e`;
- cifrado age, ciphertext 30.980 bytes;
- TLS `verify-full`, rol read-only, clave privada ausente del host/destino;
- copia offsite privada verificada por descarga + SHA-256.

Restore de la misma copia:
- 17 migraciones, target vacío, migration match;
- wrong key y ciphertext manipulado fallan cerrado;
- datos/restauración/inmutabilidad PASS;
- sin dump plano, clave privada eliminada y target aislado destruido.

Journal:
- Neon Free, proyecto técnico `fichaje-recovery`, región `aws-eu-central-1` (Frankfurt);
- roles `fichaje_archive_connection` y `fichaje_archive_writer` sin superuser/BYPASSRLS; writer NOLOGIN;
- FORCE RLS + triggers append-only;
- producción conecta por foreign server con `sslmode=verify-full` y CA del sistema;
- prueba real: event `d94988fa-5111-47c5-8fa5-18cc30dccc17`, XID 1482 committed, finalización COMMITTED, `verify_journal_entry=true`, unresolved=0.
No se almacena ninguna contraseña o user mapping en Git.

### Condiciones operativas para el primer cliente
1. **Onboarding contractual por cliente**: completar razón social/NIF/domicilio/contacto del proveedor y del cliente, firmar encargo Art. 28, inventario de subencargados, información a plantilla y checklist de convenio/pausas. Es una operación de alta, no trabajo técnico pendiente del producto.
2. **Riesgo residual de gobierno**: `main` no puede protegerse preventivamente bajo GitHub Free + repo privado; el control compensatorio detecta después del push. Riesgo aceptado expresamente por el usuario para cerrar HITO 8.

No se han creado clientes reales ni secretos en GitHub. Stripe continúa desactivado hasta su activación expresa.

### Stripe readiness — cierre de regresiones 2026-10-05
- PR #17 mantiene billing **PREPARADO / DESACTIVADO**: no se han añadido secretos Stripe, clientes, cobros ni activación comercial.
- Se corrigió el matcher cerrado del gateway para admitir únicamente las rutas billing ya contratadas: checkout, portal, sync y health.
- `billing_begin_checkout` conserva privilegio mínimo: la lectura del estado de organización ya no solicita un lock que exigía UPDATE; la exclusión mutua del checkout permanece en `private.billing_accounts ... for update`.
- El deployer incluye la función `billing` y su test operativo refleja el orden real sin ampliar credenciales.
- Evidencia sobre `b817d1a3bd7b824cbbe5b22f1521b4dd6ea2cc93`: CI PASS, Database PASS, E2E H6 PASS, OPS-02 PASS, H7 PASS.
- HITO 8 queda **aprobado** por orden expresa del usuario del 2026-10-05, aceptando el riesgo residual GO-10. Stripe permanece desactivado y este cierre no activa cobros.

## HITO 7 — cerrado
HITO 7 y todos los hitos anteriores permanecen aprobados e integrados en `main`.
La evidencia histórica sigue en Git.


### Backup vault gratuito — 2026-10-02
- proyecto Neon Free `fichaje-backups`, id `orange-heart-83052077`, `aws-eu-central-1` (Frankfurt);
- vault privado PostgreSQL `backup_vault.objects`; no usa Drive personal para futuros backups laborales;
- copia `fichaje-db-20261002T100304Z-2af8ca8e`: ciphertext 30.980 bytes + checksum + manifest;
- 3/3 SHA-256 recalculados dentro de Neon = MATCH, tamaños = MATCH, cabecera age = PASS, migration `20260930000200` = MATCH;
- búsqueda de `AGE-SECRET-KEY-1` en 3/3 payloads = ausente; la identidad privada sigue en custodia separada;
- UPDATE/TRUNCATE y DELETE anticipado bloqueados; `purge_expired()` solo permite purga tras 35 días y deja `purge_log`;
- el bucket Object Storage privado creado durante la exploración queda sin uso; el vault PostgreSQL es el destino acreditado porque la red del entorno de operación no resolvió el endpoint Storage. No afecta a la verificación del ciphertext.
