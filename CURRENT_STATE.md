# CURRENT_STATE — 2026-10-02

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
| GO-01 Código | PASS previo; repetir en HEAD documental final | HEAD de implementación `fe5b5ec73d580c7a03ab79f1c1d530c028511130`: CI, Database, E2E H6, OPS-02 y H7 = 5/5 PASS. Cualquier commit posterior obliga a comprobar de nuevo los cinco workflows antes de cierre. |
| GO-02 Destinos/TLS | PASS | Canary fija API y PostgreSQL por entorno de forma independiente; cruces staging↔production, overrides DSN, `hostaddr`, `service`, puerto no estándar y TLS débil fallan cerrado. Producción exige `verify-full`. |
| GO-03 Seguridad | PASS con riesgo residual documentado | Security Advisor sin ERROR; 20 SECURITY DEFINER revisadas: 0 ejecutables por anon, todas con search_path fijo; todas las tablas public con RLS + FORCE RLS; inmutabilidad presente; secret scan CI PASS. WARN de leaked-password protection solo disponible en Supabase Pro y no se contrata bajo política 0 €. |
| GO-04 Release | PASS | Supabase + Cloudflare sirven el mismo release aprobado; `verify_production.py` remoto final: 33 PASS / 0 FAIL / 0 SKIPPED. |
| GO-05 Canary | PASS | Tenant sintético productivo WEB + KIOSK, RLS, auditoría, idempotencia y replay. |
| GO-06 Alertas | PASS | CRITICAL entregada/resuelta en ruta real; WARNING abrió/cerró issue #24; 0 pendientes y sin PII/secrets. |
| GO-07 Recuperación | PASS técnico | Backup productivo age `fichaje-db-20261002T100304Z-2af8ca8e`, offsite privado, restore aislado de esa misma copia PASS, negativos REC-03 PASS, journal independiente Neon Frankfurt con `verify-full`, PREPARED→COMMITTED→VERIFY real y 0 unresolved. La ubicación actual del backup DB en Drive personal queda bloqueada para datos reales por GO-09. |
| GO-08 Incidente | PASS | Workflow H7 del mismo HEAD: `Incident response drill IR-01` SUCCESS; simulacro sintético cubre detección, contención, evidencia, revocación/rotación, evaluación RGPD, recuperación y reapertura autorizada. |
| GO-09 Legal/comercial | **BLOCKED** | Revisión normativa vigente hecha; plantillas Art. 28, información a plantilla, RLT/Inspección y checklist convenio/pausas existen. Bloquean: (1) backup DB en My Drive personal sin contrato Workspace/CDPA verificable como encargado; (2) completar identidad legal del proveedor y datos/firmas del primer cliente antes de datos reales. |
| GO-10 Gobierno | **BLOCKED** | Rollback está implementado/documentado y probado. GitHub informa `main protected:false`; en el repo privado actual GitHub Free no habilita protected branches/rulesets. No hacer público el repo ni contratar plan sin autorización. |

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
1. **Backup con DPA**: el destino actual de DB es un Google My Drive personal. El cifrado y la separación de la clave satisfacen el gate técnico, pero no acreditan un contrato de subencargado aplicable para datos reales. Cloudflare R2 es candidato (free tier), pero activar una suscripción de uso medido requiere autorización expresa.
2. **Identidad contractual**: completar razón social/NIF/domicilio/contacto del proveedor y los datos del cliente en `docs/legal/`; firmar encargo Art. 28, inventario de subencargados y checklist de convenio/pausas.
3. **Protección de main**: GitHub Free + repo privado no permite la protección requerida. Requiere cambio de plan o una alternativa expresamente aprobada que mantenga el repo privado.

No se han creado clientes reales ni secretos en GitHub. Cualquier gasto, publicación del repositorio, merge o activación comercial requiere autorización expresa.

## HITO 7 — cerrado
HITO 7 y todos los hitos anteriores permanecen aprobados e integrados en `main`.
La evidencia histórica sigue en Git.
