# CURRENT_STATE — 2026-10-05

## HITO 8 — GO-LIVE / producción en curso

**ESTADO ACTUAL: BLOCKED / NO CLIENTES REALES.**

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/hito-8-go-live`  
Base: `main@1b4d22488f028fb0d637cc74b15c230e8e920f6e`  
PR: #17 — OPEN; no merge ni activación comercial sin aprobación expresa posterior.

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
| GO-10 Gobierno | **BLOCKED por plataforma** | Rollback implementado/documentado/probado. GitHub informa `main protected:false` y GitHub Free no ofrece protected branches/rulesets para repos privados. Se añade `.github/workflows/main-integrity.yml` como control compensatorio: cualquier push a `main` sin PR merged + 5 workflows PASS falla y abre incidencia CRITICAL. Detecta después del push y por tanto no satisface la prohibición preventiva exigida por GO-10. |

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

### Bloqueos para el primer cliente
1. **Onboarding contractual por cliente**: completar razón social/NIF/domicilio/contacto del proveedor y del cliente, firmar encargo Art. 28, inventario de subencargados, información a plantilla y checklist de convenio/pausas. Es una operación de alta, no trabajo técnico pendiente del producto.
2. **Protección preventiva de main**: GitHub Free + repo privado no permite la protección requerida. El guard compensatorio detecta y alerta, pero no puede impedir el push. Mantener GitHub Free y repo privado deja GO-10 formalmente BLOCKED.

No se han creado clientes reales ni secretos en GitHub. Cualquier gasto, publicación del repositorio, merge o activación comercial requiere autorización expresa.

### Stripe readiness — cierre de regresiones 2026-10-05
- PR #17 mantiene billing **PREPARADO / DESACTIVADO**: no se han añadido secretos Stripe, clientes, cobros ni activación comercial.
- Se corrigió el matcher cerrado del gateway para admitir únicamente las rutas billing ya contratadas: checkout, portal, sync y health.
- `billing_begin_checkout` conserva privilegio mínimo: la lectura del estado de organización ya no solicita un lock que exigía UPDATE; la exclusión mutua del checkout permanece en `private.billing_accounts ... for update`.
- El deployer incluye la función `billing` y su test operativo refleja el orden real sin ampliar credenciales.
- Evidencia sobre `b817d1a3bd7b824cbbe5b22f1521b4dd6ea2cc93`: CI PASS, Database PASS, E2E H6 PASS, OPS-02 PASS, H7 PASS.
- HITO 8 continúa **BLOCKED exclusivamente por GO-10**; este cierre no autoriza merge, clientes reales ni cobros.

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
