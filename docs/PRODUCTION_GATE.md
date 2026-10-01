# PREPROD-01 — puerta previa al primer cliente real / producción

Revisión inicial: 2026-10-01. Esta puerta empieza solo después de HITO 7 aprobado e integrado.
No autoriza por sí misma producción, datos laborales reales, alta de clientes reales ni gasto.

## Objetivo
Demostrar que Fichaje APP puede pasar de staging sintético a operación real con una empresa española
sin debilitar aislamiento, inmutabilidad, trazabilidad, recuperación, privacidad ni coste controlado.

## Regla de salida
PREPROD-01 solo puede declararse PASS cuando **todos** los controles PRE-01..PRE-10 estén verificados
con evidencia real y no quede ningún BLOCKED. Un PASS técnico no autoriza producción: después se requiere
una orden expresa del usuario para activar producción / primer cliente real.

## Controles

| ID | Control | Estado inicial | Evidencia exigida |
|---|---|---|---|
| PRE-01 | Base normativa vigente y convenio aplicable | PARTIAL | Revisión con fuentes primarias en fecha de alta; art. 34.9 ET, RGPD/LOPDGDD y convenio/empresa concreta |
| PRE-02 | Paquete legal comercial | BLOCKED | Encargo art. 28, subencargados, transferencias/localización, información empleados, derechos, incidentes, baja y retención completados sin marcadores |
| PRE-03 | Entorno de producción aislado | BLOCKED | Supabase + Cloudflare separados de staging; región UE; secretos distintos; cero datos sintéticos heredados |
| PRE-04 | Dominio y protección de borde | BLOCKED | Dominio definitivo, TLS/HSTS, CSP, WAF/rate limits verificados; sin bypass de edge |
| PRE-05 | Correo transaccional | BLOCKED | SMTP/proveedor aprobado, confirmación e invitaciones probadas sin exponer tokens; SPF/DKIM/DMARC cuando aplique |
| PRE-06 | Alertas reales y operación | BLOCKED | CRITICAL y WARNING recibidos por rutas reales, RESOLVED probado, canary e invariantes programados |
| PRE-07 | Backup/restore real | BLOCKED | Backup cifrado activo, destino privado, clave age separada, restore aislado real REC-01..03, RPO/RTO medidos |
| PRE-08 | Seguridad independiente | BLOCKED | Revisión independiente de RLS/Auth/edge/Storage/dependencias y resolución de hallazgos críticos/altos |
| PRE-09 | Ensayo final production-like | BLOCKED | Alta, OWNER/ADMIN/EMPLOYEE, kiosco, ciclo horario, corrección, exportación, aislamiento y fallo/rollback con datos sintéticos |
| PRE-10 | Autorización primer cliente | BLOCKED | Empresa concreta + convenio revisados; contratos firmados; aprobación expresa del usuario para producción y datos reales |

## Revisión normativa 2026-10-01

Fuentes primarias verificadas:
- Estatuto de los Trabajadores, art. 34.9 (BOE-A-2015-11430): registro diario con inicio y fin,
  conservación cuatro años y disponibilidad a persona trabajadora, representantes e Inspección.
- RGPD, arts. 28 y 32: contrato responsable/encargado y medidas técnicas/organizativas adecuadas,
  incluyendo confidencialidad, integridad, disponibilidad, resiliencia y capacidad de restauración.
- AEPD, FAQ de control horario: la base ordinaria es obligación legal, no consentimiento, pero existe deber de información.
- Convenios publicados en 2026 confirman que el convenio puede concretar sistema, pausas, trabajo efectivo,
  incidencias, accesibilidad y forma de entrega; por tanto el onboarding real debe revisar el convenio aplicable.

No se declara que Fichaje sea universalmente válido para todos los sectores sin esa revisión concreta.

## Política de coste
Mantener 0 € mientras sea compatible con PRE-01..PRE-10. Si un control exige coste real
(p. ej. segundo entorno gestionado, dominio, correo, backup o revisión profesional), detenerse antes de contratar,
documentar coste/beneficio y solicitar autorización expresa.

## Límites durante PREPROD-01
- Sin datos reales.
- Sin cliente real.
- Sin merge sin aprobación.
- Sin producción hasta PRE-01..PRE-10 y autorización posterior.
- Sin secretos en GitHub.
- Cambios mínimos y tests obligatorios.
