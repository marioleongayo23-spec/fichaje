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
| PRE-02 | Paquete legal comercial | PARTIAL | Encargo art. 28, subencargados, transferencias/localización, información empleados, derechos, incidentes, baja y retención completados sin marcadores y revisión jurídica independiente documentada |
| PRE-03 | Entorno de producción aislado | PARTIAL | Supabase + Cloudflare separados de staging; región UE; secretos distintos; cero datos sintéticos heredados |
| PRE-04 | Dominio y protección de borde | BLOCKED | Dominio definitivo, TLS/HSTS, CSP, WAF/rate limits verificados; sin bypass de edge |
| PRE-05 | Correo transaccional | PARTIAL | SMTP/proveedor aprobado, confirmación e invitaciones probadas sin exponer tokens; SPF/DKIM/DMARC cuando aplique |
| PRE-06 | Alertas reales y operación | PARTIAL | CRITICAL y WARNING recibidos por rutas reales, RESOLVED probado, canary e invariantes programados |
| PRE-07 | Backup/restore real | BLOCKED | Backup cifrado activo, destino privado, clave age separada, restore aislado real REC-01..03, RPO/RTO medidos |
| PRE-08 | Seguridad independiente | PARTIAL | Revisión independiente de RLS/Auth/edge/Storage/dependencias y resolución de hallazgos críticos/altos |
| PRE-09 | Ensayo final production-like | BLOCKED | Alta, OWNER/ADMIN/EMPLOYEE, kiosco, ciclo horario, corrección, exportación, aislamiento y fallo/rollback con datos sintéticos; simulacro humano con recepción/acuse de guardia, evaluación de comunicación/notificación y postmortem |
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
- Candidato productivo autorizado exclusivamente con datos sintéticos; sin operación con clientes/datos reales hasta PRE-01..PRE-10 y autorización posterior.
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


## Alertas y borde a coste 0 € — 2026-10-01
**PRE-06:** PagerDuty Incident Management Free es el candidato preferente para CRITICAL: 0 USD/año,
hasta 5 usuarios, una guardia y una política de escalado, con notificaciones básicas por email/push/SMS/teléfono.
Encaja con el adaptador `pagerduty` ya implementado. WARNING seguirá usando GitHub Issues privado con token
fine-grained limitado a Issues R/W. No se han creado cuentas/tokens ni rutas reales todavía.

Better Stack Free se evaluó, pero su capa gratuita prioriza monitores y alertas email/Slack; las capacidades
de responder/on-call con teléfono pertenecen a licencia de responder de pago. No se selecciona para esta puerta.

**PRE-04:** Cloudflare Pages puede alojar un segundo proyecto productivo en Free; estáticos son gratuitos y
las Pages Functions consumen la cuota Workers Free (100.000 requests/día compartidos). WAF/rate limiting de
zona está disponible en Free con restricciones de campos, pero exige que el dominio esté añadido a Cloudflare.
El `*.pages.dev` no es una zona propia sobre la que Fichaje pueda aplicar esas reglas. Por tanto el dominio
propio sigue siendo el bloqueo real de PRE-04; no se compra todavía.

## Backup real a coste 0 € — límite actual
Supabase recomienda que Free exporte regularmente con CLI/`db dump`; no ofrece los backups gestionados de
Pro. El pipeline de Fichaje ya cifra en stream con age y exige restore aislado, pero necesita un **host de
operación fiable** que ejecute diariamente `pg_dump`, custodie credenciales fuera de GitHub y verifique el
destino. GitHub Actions no recibirá secretos persistentes por contrato del proyecto.

Se puede ejecutar un ensayo remoto de backup/restore con datos sintéticos y un proyecto temporal Free cuando
se autorice infraestructura, pero eso no resuelve por sí solo el backup diario productivo. PRE-07 permanece
BLOCKED hasta disponer de host de operación fiable o aprobar una alternativa gestionada (por ejemplo Pro)
antes de introducir el primer dato real.


## PRE-03 — candidato Supabase reactivado 2026-10-01

Autorización expresa del usuario recibida para reactivar exclusivamente el proyecto existente `Fichaje APP`.

Resultado:
- project ref: `bypdviatamosygndeqhh`;
- región: `eu-west-1` (Irlanda);
- organización Supabase: plan Free;
- estado tras restore: `ACTIVE_HEALTHY`;
- migraciones: 0;
- tablas de aplicación en `public`/`private`: 0;
- usuarios Auth: 0;
- objetos Storage: 0;
- Edge Functions: 0;
- Security Advisor: 0 lints en el proyecto vacío.

Conclusión: el proyecto está vacío y separado de `fichaje-staging`, por lo que es candidato válido para
construir el entorno productivo sin arrastrar datos sintéticos. PRE-03 permanece PARTIAL hasta aplicar
migraciones desde cero, configurar Auth/Storage/Edge/secrets propios, crear Cloudflare productivo separado
y superar la verificación production-like. No se ha desplegado código ni creado datos reales.


## PRE-03 — esquema productivo aplicado 2026-10-01

Con autorización expresa del usuario para configurar `Fichaje APP` como candidato productivo:
- 17/17 migraciones de `supabase/migrations` aplicadas en orden sobre la base vacía;
- el historial de `supabase_migrations.schema_migrations` se normalizó después para conservar exactamente
  los timestamps/nombres de los archivos Git (el conector había registrado inicialmente timestamps de ejecución);
- todas las tablas `public` y `private` creadas aparecen con RLS habilitado;
- bucket `fichaje-evidence` creado como privado, límite 10 MiB y MIME `application/zip`;
- 0 usuarios Auth, 0 organizaciones, 0 memberships, 0 empleados, 0 fichajes y 0 objetos Storage;
- URL pública y publishable key propias del proyecto disponibles; no se han copiado credenciales de staging;
- Security Advisor: únicamente el patrón esperado de 20 RPC `SECURITY DEFINER` intencionales; sin lints
  adicionales de configuración en este punto.

Pendiente para completar PRE-03: Edge Secrets exclusivos, Auth productivo, login técnico de gateway,
Edge Functions `kiosk`/`export-link`, Cloudflare productivo separado y verificación production-like.

## Continuidad verificable — 2026-10-01

Evidencia técnica y límites de esta sesión: CURRENT_STATE.md, sección Verificación de continuidad.
Se permite preparar el candidato sintético; ello no equivale a activar producción con clientes reales.
La documentación histórica de inventario conserva su fecha y no describe el estado actual del candidato.

### Dependencias agrupadas antes del primer cliente

| PRE | Qué falta / por qué es obligatorio | Coste / intervención mínima |
|---|---|---|
| 01, 02, 10 | Identidad contractual/fiscal del proveedor, cliente y convenio concretos, anexos y contratos revisados/firma. El convenio se revisa por cada cliente; la baseline estatal no acredita todos los sectores. | Información/decisiones: 0 EUR. Revisión jurídica independiente: presupuesto no disponible; no inventar tarifa ni contratar. Facilitar identidad y designar revisor/asesoría. |
| 03, 09 | Acceso autorizado a la configuración de secretos/Auth y Cloudflare; desplegar y verificar release, gateway, secretos propios y ensayo completo. El bloqueo de navegador impide acreditar el entorno completo. | 0 EUR en los planes actuales. Autorizar expresamente acceso a secretos del candidato y resolver la autenticación/verificación de la cuenta cuando sea posible. Nunca enviar contraseñas/tokens por chat. |
| 04, 05 | Dominio definitivo bajo control del proveedor y DNS; borde/WAF y correo SPF/DKIM/DMARC no se verifican con un dominio inventado. | 0 EUR adicional si ya dispone de dominio; adquisición/renovación depende del dominio elegido y no está presupuestada. Indicar dominio disponible y autorizar DNS; no comprar. |
| 05 | Cuenta/DPA de Brevo Free y acceso seguro a SMTP; envío real de confirmación, invitación y recuperación. SMTP de prueba de Supabase no cierra el control. | Plan Free: 0 EUR dentro de su cuota; falta alta/aceptación de términos por el titular y verificación de dominio. Agrupar con DNS/identidad contractual. |
| 06, 09 | Cuenta de guardia PagerDuty Free y custodio; token Issues mínimo fuera de GitHub; host programado; prueba CRITICAL/WARNING/RESOLVED y simulacro humano. Los receptores de CI no prueban entrega a guardia real. | PagerDuty Free: 0 USD/año; Issues sin plan adicional. El titular acepta términos/designa guardia y proporciona acceso seguro en host, no tokens por chat. |
| 07, 06 | Host fiable externo, destino privado, identidad age separada y journal PostgreSQL independiente con TLS verificable; backup del candidato y restore aislado del mismo backup REC-01..03. | 0 EUR de servicios nuevos solo si ya existen recursos fiables y custodia. Sin ellos no hay alternativa de 0 EUR acreditada para este contrato. Pro base 25 USD/mes no incluye host/journal independiente/objetos Storage ni sustituye este ensayo; no presentarlo como cierre automático. Elegir host/journal/destino disponibles o solicitar presupuesto completo antes de contratar. |
| 08 | Revisión de seguridad independiente con evidencia del candidato, resolución de CRITICAL/HIGH y repetición de pruebas. Advisor/CI/autorrevisión no sustituyen independencia. | 0 EUR si un revisor independiente competente lo aporta sin cobrar; tarifa profesional desconocida hasta presupuesto. Designar revisor y alcance; no contratar. |
| 10 | Primer cliente concreto, contratos/checklist y autorización posterior para datos reales/cutover. | 0 EUR por autorización; no solicitarla antes de cerrar controles anteriores. |

Fuentes oficiales de costes/limitaciones consultadas el 2026-10-01:
- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/backups
- https://www.pagerduty.com/pricing/
- https://www.brevo.com/pricing/

No se han contratado servicios. Precio de dominio y revisiones humanas no puede expresarse como importe exacto sin una elección/presupuesto; cualquier cifra sería inventada.
