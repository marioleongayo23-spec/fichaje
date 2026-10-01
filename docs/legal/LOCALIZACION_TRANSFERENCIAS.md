# Localización de datos y transferencias internacionales — REVISABLE

> Revisión GO-LIVE 2026-10-01. Distinguir ubicación primaria del proyecto de todas las ubicaciones
> desde las que proveedores/subencargados pueden prestar soporte o procesar metadatos.

## Localización técnica

| Componente | Situación verificada | Decisión / límite |
|---|---|---|
| PostgreSQL, Auth, Storage y Edge Functions — Supabase producción | Proyecto `bypdviatamosygndeqhh` en `eu-west-1`; Supabase documenta `eu-west-1` como West EU (Ireland) | Mantener esta región; no afirmar que toda actividad de soporte/subencargados queda exclusivamente en UE |
| PostgreSQL, Auth, Storage y Edge Functions — staging | Proyecto `pvfjffeszsedslmwdvgh` en `eu-west-1` | Solo sintético/staging salvo journal técnico futuro expresamente aprobado |
| Frontend/gateway — Cloudflare Pages/Workers | Red global por defecto | No se almacenan intencionadamente registros laborales en assets/logs de aplicación; la localización estricta de Pages requiere Data Localization Suite/controles adicionales de pago |
| Backup DB | Destino privado candidato `Fichaje APP - BACKUP/02 - DB Encrypted Backups`; vacío de datos DB reales | No activar hasta verificar DPA/transferencias del destino o elegir alternativa; cifrado age no elimina su carácter de dato personal |
| Journal de recuperación | Aún no aprovisionado | Debe residir en instancia independiente del backup productivo y mantenerse disponible durante restore |

## Transferencias (arts. 44–49 RGPD)

- Supabase publica DPA vigente (versión 1, 01-08-2026). El DPA contempla SCC UE y que, cuando se
  selecciona una región específica, los datos se almacenan y procesan principalmente allí, sin excluir
  tratamientos necesarios de soporte/subencargados conforme al contrato.
- La lista de subencargados de Supabase publicada el 01-06-2026 incluye, entre otros, Amazon Web Services,
  Cloudflare y otros proveedores de soporte/infraestructura. Debe vigilarse su mecanismo de actualizaciones.
- Cloudflare publica DPA v6.4 (03-04-2026), con SCC y mecanismos de transferencia. Para clientes self-service
  Cloudflare indica que su DPA queda incorporado a las condiciones y cubre los mecanismos de transferencia.
- Cloudflare Pages funciona globalmente por defecto. Regional Services/Customer Metadata Boundary permiten
  controles de localización, pero pertenecen a Data Localization Suite y no se presupuestan en la política
  de coste 0 €. Por tanto, Fichaje APP no comercializará una promesa de «procesamiento exclusivamente UE»
  para el borde mientras esa configuración no exista.

Medidas complementarias técnicas: TLS; `verify-full` en conexiones PostgreSQL técnicas; RLS y mínimo
privilegio; backups age con clave separada; no biometría/geolocalización; IP de kiosco minimizada por HMAC;
telemetría y alertas sin PII.

Fuentes:
- https://supabase.com/docs/guides/platform/regions
- https://supabase.com/legal/customer-resources/data-processing-addendum
- https://supabase.com/legal/customer-resources/subprocessor-list
- https://www.cloudflare.com/cloudflare-customer-dpa/
- https://www.cloudflare.com/trust-hub/gdpr/
- https://developers.cloudflare.com/data-localization/how-to/pages/
- https://developers.cloudflare.com/data-localization/

## Antes del primer contrato

Confirmar la entidad jurídica del proveedor de Fichaje, la entidad que figura en las cuentas de Supabase,
Cloudflare y el eventual destino de backup; conservar la versión aplicable de DPA/lista de subencargados;
completar el anexo contractual del cliente y su convenio aplicable. Esta ficha no sustituye esa comprobación.
