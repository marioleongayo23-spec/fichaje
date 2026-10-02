# Localización de datos y transferencias internacionales — PREPRODUCCIÓN H8

> Revisión 2026-10-02. Se separa ubicación técnica de garantía jurídica: alojar el dato en la UE no elimina
> por sí solo posibles accesos/transferencias por soporte, afiliadas o subprocesadores.

## Localización técnica actual
| Componente | Ubicación / tratamiento | Estado |
|---|---|---|
| Supabase PostgreSQL/Auth/Storage/Edge | `eu-west-1`, West EU (Irlanda) | Producción candidata; solo datos sintéticos hasta GO-09/10 |
| Journal de recuperación Neon | `aws-eu-central-1`, Frankfurt | Independiente del primario y del backup; GO-07 PASS |
| Cloudflare Pages/borde | Red global; requests procesadas en el borde | No se usa como archivo de registros laborales |
| Backup DB age | Neon proyecto separado `fichaje-backups`, `aws-eu-central-1` Frankfurt; vault PostgreSQL privado; clave age separada | GO-07/GO-09 PASS de readiness; SHA/tamaño/inmutabilidad y rotación 35 días verificadas |
| Backup de repositorio | Google My Drive privado | Sin datos personales laborales por contrato de OPS-01 |

## Garantías verificadas
- **Supabase:** DPA v1 01/08/2026; el DPA declara que, cuando el cliente fija una región, Covered Data se
  almacena y procesa primariamente allí salvo las excepciones contractuales. Incorpora SCC de la Decisión
  (UE) 2021/914 para transferencias aplicables.
  https://supabase.com/legal/customer-resources/data-processing-addendum
- **Cloudflare:** DPA v6.4 03/04/2026 y SCC para transferencias EEE/UK/Suiza.
  https://www.cloudflare.com/cloudflare-customer-dpa/
- **Neon/Databricks:** Product Specific Schedule Neon + DPA/DTA Databricks; lista de subprocesadores vigente.
  https://neon.com/platform-terms
  https://www.databricks.com/legal/dpa
  https://www.databricks.com/legal/data-transfer-addendum
- **Google:** My Drive personal no se usa como destino de futuros backups laborales; se mantiene únicamente
  para código/evidencia sintética sin datos de empleados.
- **Neon/Databricks backup vault:** el segundo proyecto `fichaje-backups` queda bajo el mismo Product Specific
  Schedule/DPA verificado para Neon, pero es un recurso distinto del journal. La clave age no se almacena allí.

## Medidas complementarias
TLS `verify-full` en conexiones técnicas, backups cifrados age con identidad privada fuera del destino,
originales y correcciones inmutables/append-only, minimización sin biometría/fotos/geolocalización,
IP de kiosco solo como HMAC por empresa y alertas sin PII.

## Decisiones H8
| Fecha | Decisión |
|---|---|
| 2026-10-02 | Supabase productivo fijado a `eu-west-1` (Irlanda). |
| 2026-10-02 | Journal independiente fijado a Neon `aws-eu-central-1` (Frankfurt), TLS `verify-full`. |
| 2026-10-02 | My Drive personal queda solo para evidencia sintética/código y **prohibido para futuros backups laborales**. |
| 2026-10-02 | Backup laboral migrado a proyecto Neon Free separado `fichaje-backups` en Frankfurt; Cloudflare R2 descartado por requerir suscripción de uso medido. |
