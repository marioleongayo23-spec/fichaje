# Producción — HITO 8 GO-LIVE

## Estado
Puerta previa al primer cliente real. Esta documentación **no activa producción** por sí sola.
No introducir datos reales ni anunciar disponibilidad comercial hasta que todos los criterios
GO-01..GO-10 estén PASS y exista aprobación expresa posterior del usuario.

## Candidato productivo
- Supabase: proyecto existente `Fichaje APP`, ref `bypdviatamosygndeqhh`, región `eu-west-1`.
- Auditoría inicial 2026-10-01: ACTIVE_HEALTHY; 17 migraciones, hasta
  `20260930000200_export_generation.sql`, iguales a staging.
- Datos al iniciar H8: 0 organizaciones, 0 memberships, 0 empleados, 0 fichajes,
  0 usuarios Auth y 0 objetos Storage; existe únicamente el bucket privado técnico.
- Staging permanece separado: `pvfjffeszsedslmwdvgh`. Nunca reutilizar sus secretos,
  identidades sintéticas ni URLs como configuración de producción.
- El código de `kiosk` se sincronizó durante H8 con `main` (ACTIVE v6) y `export-link`
  ya coincidía archivo a archivo. Esto elimina deriva de fuente, pero **no** acredita GO-04:
  faltan el borde Cloudflare productivo, una identidad de release común y el verificador remoto.

## Puerta GO-LIVE
| Criterio | Evidencia obligatoria |
|---|---|
| GO-01 Código | H8 en rama propia, PR contra `main`, CI/Database/E2E/OPS-02/H7 del HEAD final PASS; sin merge automático |
| GO-02 Destinos | API y PostgreSQL de cada entorno fijados independientemente; canary rechaza cruces staging↔production y exige TLS `verify-full` |
| GO-03 Seguridad | Security Advisor revisado; RLS/grants/inmutabilidad sin regresión; secreto scan PASS; ningún secreto persistente en GitHub |
| GO-04 Release | Cloudflare y Supabase sirven el mismo commit/release aprobado; `verify_production.py` remoto PASS con 0 SKIPPED |
| GO-05 Canary | Tenant exclusivamente sintético en producción completa WEB + KIOSK, RLS, audit e idempotencia; nunca datos de cliente como sonda |
| GO-06 Alertas | CRITICAL entregada y resuelta por ruta real de guardia; WARNING crea/cierra ticket real; sin PII/secretos |
| GO-07 Recuperación | Backup DB cifrado real a destino privado; clave age separada; monitor OK solo tras restore aislado de esa misma copia; journal verificado |
| GO-08 Incidentes | Simulacro sintético: detección, contención, evidencia, revocación/rotación, evaluación RGPD, recuperación y reapertura autorizada |
| GO-09 Legal/comercial | Revisión normativa vigente, encargo art. 28 RGPD, subencargados/transferencias, información a plantilla y convenio/pausas por cliente |
| GO-10 Gobierno | `main` protegido contra push/merge sin checks; rollback documentado; autorización expresa de producción y del primer cliente |

Un WARN genérico del Security Advisor sobre una RPC `SECURITY DEFINER` no se silencia ni se
corrige mecánicamente: se contrasta con el contrato de `SECURITY.md`, sus GRANT explícitos,
autorización servidor y tests de aislamiento. Cualquier hallazgo que contradiga ese contrato bloquea GO-03.

## Verificación de producción
`scripts/production/verify_production.py` reutiliza el verificador externo H7 y añade:
- `FICHAJE_ENV=production`;
- pins obligatorios `FICHAJE_PRODUCTION_APP_HOST` y `FICHAJE_PRODUCTION_API_HOST`;
- estado canary sintético obligatorio y archivo owner-only;
- prohibición de reutilizar los hosts de staging si están cargados.

El provisionador del canary exige además `FICHAJE_PRODUCTION_DB_HOST` y comprueba que el
destino efectivo de la DSN coincide exactamente, con `sslmode=verify-full`. Se rechazan
`service=`, `hostaddr`, overrides de host/puerto/DB en la query URI, campos objetivo
duplicados y puertos remotos distintos de 5432. La API/app remota solo acepta HTTPS estándar.

## Recuperación
Una base vacía también es un backup válido. Desde H8, `restore_database.sh` determina el
éxito por el pipeline de descifrado/`pg_restore`, la transacción única y las FK, no por la
existencia de una organización. Un fallo de `pg_restore` fuerza ROLLBACK y estado de fallo.

La restauración real no se ensaya contra una base viva. El objetivo debe ser vacío, aislado,
con las mismas migraciones, y el journal se reaplica antes de abrir acceso.

## Coste
Política vigente: 0 € hasta que sea estrictamente necesario y los ingresos/riesgo lo justifiquen.
H8 no contrata automáticamente Supabase Pro, PagerDuty, SMTP, dominio ni otra infraestructura.
Si GO-06/GO-07/GO-09 requieren un proveedor de pago y no existe alternativa equivalente,
el criterio queda BLOCKED y se presenta el coste antes de contratar nada.
