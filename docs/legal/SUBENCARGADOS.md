# Inventario de subencargados (art. 28.2 y 28.4 RGPD) — REVISABLE

> Revisión GO-LIVE 2026-10-01. Se han verificado las fuentes públicas vigentes de los proveedores
> técnicos principales. La entidad exacta que figura en cada cuenta/factura y la aceptación contractual
> del proveedor de Fichaje deben confirmarse antes del primer cliente real.

| Proveedor | Servicio | Datos personales tratados | Región / ubicación | Garantía de transferencia | DPA | Estado |
|---|---|---|---|---|---|---|
| Supabase Pte. Ltd (según DPA publicada; confirmar entidad de la cuenta) | PostgreSQL, Auth, Storage, Edge Functions | Datos del registro horario y cuentas | Proyecto productivo `eu-west-1` = Irlanda | DPA + SCC UE cuando procedan | DPA vigente publicada, versión 1 de 01-08-2026 | Verificado documentalmente; aceptación/cuenta por confirmar |
| Amazon Web Services, Inc (subencargado de Supabase) | Hosting subyacente | Según servicio de Supabase | Región primaria del proyecto; otros tratamientos de soporte según DPA/lista | Vía contrato/DPA de Supabase | Vía Supabase | Consta en lista Supabase de 01-06-2026 |
| Cloudflare, Inc | Pages/Workers, TLS, protección de red y gateway | Metadatos de conexión y cuerpos en tránsito; no persistencia intencionada de registros laborales en Pages | Red global por defecto; localización estricta de Pages requiere controles adicionales de pago | DPA + SCC/DPF según supuesto | DPA v6.4, 03-04-2026 | Verificado documentalmente; no prometer residencia UE total |
| `[[PROVEEDOR SMTP / EMAIL DE AUTH]]` | Emails de confirmación/recuperación | Email del usuario humano | `[[…]]` | `[[…]]` | `[[…]]` | Pendiente de decisión/configuración |
| GitHub | Código, CI y ruta operativa de alertas privada | Sin datos de empleados por contrato técnico; solo datos sintéticos y alertas minimizadas | Servicio global | N.A. mientras no se introduzca PII | N.A. para el alcance actual | Uso actual; CRITICAL/WARNING reales probados sin PII |
| Google Drive | Backup de repositorio | Ninguno en el uso actual | Servicio global | N.A. para backup de código | N.A. para uso actual | Uso actual sin datos laborales |
| Google Drive u otro destino rclone `[[DECISIÓN FINAL]]` | Backup DB cifrado con age | Datos laborales cifrados; siguen siendo datos personales | `[[VERIFICAR]]` | `[[DPA/SCC/DPF SEGÚN DESTINO]]` | `[[VERIFICAR]]` | Solo candidato; no contiene backup DB real |
| Supabase staging `pvfjffeszsedslmwdvgh` u otra instancia independiente `[[DECISIÓN FINAL]]` | Journal de recuperación | UUID y metadatos técnicos de bajas/holds/purgas; sin nombres, fichajes ni motivos libres | `eu-west-1` si se usa el proyecto staging | Igual que Supabase | Igual que Supabase | Propuesta técnica; no aprovisionada |

Fuentes revisadas:
- Supabase DPA: https://supabase.com/legal/customer-resources/data-processing-addendum
- Supabase regiones: https://supabase.com/docs/guides/platform/regions
- Supabase subprocessors (01-06-2026): https://supabase.com/legal/customer-resources/subprocessor-list
- Cloudflare DPA v6.4: https://www.cloudflare.com/cloudflare-customer-dpa/
- Cloudflare subprocessors: https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/
- Cloudflare Pages/data localization: https://developers.cloudflare.com/data-localization/how-to/pages/

La lista de Supabase puede cambiar; su DPA prevé actualización y mecanismo de notificación/oposición.
El inventario contractual entregado a clientes debe versionarse y actualizarse cuando cambien subencargados.

Procedimiento de cambios con clientes: `[[PLAZO DE PREAVISO CONTRACTUAL]]`, canal de oposición,
actualización del anexo y responsable interno `[[RESPONSABLE]]`.
