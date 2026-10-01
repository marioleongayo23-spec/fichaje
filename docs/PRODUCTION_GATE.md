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
| PRE-02 | Paquete legal comercial | PARTIAL | Encargo art. 28, subencargados, transferencias/localización, información empleados, derechos, incidentes, baja y retención completados sin marcadores |
| PRE-03 | Entorno de producción aislado | BLOCKED | Supabase + Cloudflare separados de staging; región UE; secretos distintos; cero datos sintéticos heredados |
| PRE-04 | Dominio y protección de borde | BLOCKED | Dominio definitivo, TLS/HSTS, CSP, WAF/rate limits verificados; sin bypass de edge |
| PRE-05 | Correo transaccional | PARTIAL | SMTP/proveedor aprobado, confirmación e invitaciones probadas sin exponer tokens; SPF/DKIM/DMARC cuando aplique |
| PRE-06 | Alertas reales y operación | BLOCKED | CRITICAL y WARNING recibidos por rutas reales, RESOLVED probado, canary e invariantes programados |
| PRE-07 | Backup/restore real | BLOCKED | Backup cifrado activo, destino privado, clave age separada, restore aislado real REC-01..03, RPO/RTO medidos |
| PRE-08 | Seguridad independiente | PARTIAL | Revisión independiente de RLS/Auth/edge/Storage/dependencias y resolución de hallazgos críticos/altos |
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


## Avance 2026-10-01
- PRE-01: baseline estatal/AEPD verificada; falta convenio de cliente concreto.
- PRE-02: DPA y fuentes oficiales de subencargados de Supabase/Cloudflare verificadas; faltan entidad
  contratante de Fichaje, proveedores aún no elegidos, completar marcadores y revisión jurídica independiente.
- PRE-03: se fija como requisito región específica de la UE para Supabase producción; entorno aún no creado.


## Inventario de infraestructura — 2026-10-01
- Supabase: `fichaje-staging` ACTIVE_HEALTHY y `Fichaje APP` INACTIVE, ambos en `eu-west-1`.
  `Fichaje APP` es candidato a producción aislada; no se ha restaurado ni inspeccionado su contenido.
- Cloudflare: solo existe `fichaje-staging`; no existe aún proyecto Pages productivo.
- No se ha realizado ninguna mutación de infraestructura ni contratación durante este inventario.


## Candidato SMTP 0 € — 2026-10-01
Supabase documenta que su SMTP por defecto no es apto para producción y exige configurar un servidor SMTP propio.
Para mantener coste 0 € se selecciona **Brevo Free** como candidato inicial, sujeto a alta/aceptación contractual:
- SMTP transaccional compatible con Supabase;
- 300 emails/día en plan Free según documentación vigente;
- documentación pública de RGPD/DPA y centros de datos principales en la UE.

No se crea cuenta todavía. PRE-05 sigue PARTIAL hasta disponer de dominio de envío, DPA/entidad contratante,
SPF/DKIM/DMARC y prueba real de confirmación/recuperación. Alternativas evaluadas: Resend Free (3.000/mes,
100/día) dispone de DPA/SCC, pero declara almacenamiento de datos de cliente en EE. UU., lo que añade análisis
de transferencia innecesario para la primera opción.


## Coste Supabase para producción — 2026-10-01
La documentación vigente permite dos proyectos activos en Free; un proyecto pausado no cuenta contra el límite.
Por tanto, staging + el candidato `Fichaje APP` podrían coexistir a 0 € si el segundo se reactiva.

Limitaciones de Free relevantes para la decisión comercial:
- Supabase puede pausar proyectos de baja actividad tras una ventana de 7 días; actividad real/monitorización
  suele evitarlo, pero Free no ofrece garantía de no-pausa.
- Los backups gestionados descargables no están incluidos; PRE-07 debe satisfacerse con el pipeline externo
  cifrado/restore ya diseñado mientras se permanezca en Free.
- Pro empieza en 25 USD/mes por organización, no por cliente, e incluye no-pausa por inactividad y backups
  diarios de 7 días. No se contrata en PREPROD-01 sin autorización expresa.

Conclusión: **Pro no es un requisito legal ni un coste por cliente**. Es una decisión de fiabilidad que se
reevaluará al activar el primer cliente/ingresos. La puerta no puede ocultar las limitaciones de Free.


## Revisión automática de seguridad PRE-08 — 2026-10-01
Supabase Security Advisor ejecutado contra staging:
- 0 hallazgos CRITICAL/HIGH reportados por el advisor.
- WARN: 20 RPC `SECURITY DEFINER` ejecutables por `authenticated`. Es un patrón **intencional** del
  contrato de Fichaje: funciones públicas acotadas, autorización explícita de actor/tenant, propietarios
  técnicos mínimos, `search_path=''`, RLS/GRANT y suites de abuso/cross-tenant. No se cambia a
  `SECURITY INVOKER` ni se revoca EXECUTE de forma mecánica porque rompería el API previsto y no
  resolvería por sí mismo la autorización.
- WARN: leaked-password protection desactivada. Supabase la ofrece en planes Pro y superiores; mientras
  se mantenga Free no se declara disponible.
- El registro self-service exige mínimo 12 caracteres en UI. Antes de producción debe verificarse y fijarse
  además la política **autoritativa** de Auth del proyecto productivo; el cliente no es control de seguridad.
- Advisor de rendimiento: 28 FK sin índice de cobertura, 2 índices sin uso y 4 conjuntos de políticas RLS
  permisivas múltiples. Son avisos de rendimiento; no se modificarán índices/policies sin evidencia de
  consulta/carga porque correctitud y aislamiento prevalecen.

PRE-08 permanece PARTIAL: falta revisión independiente externa/final del candidato productivo y resolver
cualquier hallazgo crítico/alto que esa revisión encuentre.
