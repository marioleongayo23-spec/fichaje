# Localización de datos y transferencias internacionales — PLANTILLA REVISABLE

> H7, 2026-09-28. Decisión técnica documentada; la verificación contractual de cada proveedor está pendiente.

## Localización (decisión técnica)
| Componente | Ubicación objetivo | Verificación pendiente |
|---|---|---|
| PostgreSQL, Auth, Storage, Edge Functions (Supabase) | Región UE `[[REGIÓN]]` fijada al crear el proyecto (no se puede cambiar después) | Confirmar región en el panel y en el contrato |
| Backups cifrados de base de datos | Destino privado en la UE `[[DESTINO]]`; la clave privada age en custodia separada `[[CUSTODIA]]` | Contrato del destino; prueba de restauración trimestral |
| Journal de recuperación | Instancia PostgreSQL independiente en la UE `[[INSTANCIA]]` | Persistencia y custodia independientes del backup |
| Frontend y borde (Cloudflare Pages) | Red global; sin almacenamiento de registros laborales | Configuración de logs/analítica del proveedor |

## Transferencias (arts. 44–49 RGPD)
- Un proveedor con sede o acceso desde fuera del EEE puede implicar transferencia aunque los datos se alojen en
  la UE (p. ej., soporte remoto o subencargados). Para cada proveedor documentar la garantía aplicable:
  decisión de adecuación (p. ej., Marco de Privacidad de Datos UE-EE. UU. si la entidad está certificada),
  cláusulas contractuales tipo o normas corporativas vinculantes.
- **Estado de la certificación y de las garantías: `[[VERIFICAR EN LA FUENTE OFICIAL A LA FECHA DE FIRMA]]`.**
  No se ha podido consultar desde el entorno de H7.
- Medidas complementarias técnicas ya implementadas: cifrado en tránsito (TLS, verify-full en conexiones
  técnicas), backups cifrados con clave fuera del proveedor, minimización (sin biometría/geolocalización, IP de
  kiosco solo como HMAC por empresa), alertas y telemetría sin datos personales.

## Registro de decisiones
| Fecha | Decisión | Responsable |
|---|---|---|
| `[[FECHA]]` | Región de Supabase `[[REGIÓN]]` | `[[…]]` |
| `[[FECHA]]` | Destino de backups `[[…]]` | `[[…]]` |


## Verificación PREPROD-01 — 2026-10-01

Supabase documenta que la región elegida determina dónde se almacena el dato primario del proyecto y
advierte que una región general "Europe" puede desplegar incluso en Londres o Zúrich. Para producción de
Fichaje se exigirá una **región específica situada en un Estado miembro de la UE**; no se usará una región
general ambigua. Staging está actualmente en `eu-west-1` (Irlanda), pero producción tendrá su propia decisión
y evidencia.

Fuente oficial de regiones:
https://supabase.com/docs/guides/platform/regions

El DPA de Supabase indica que, cuando el cliente dirige el tratamiento a una región específica, los datos
cubiertos se almacenan y procesan primariamente allí, sujeto a las excepciones contractuales y a
subencargados/transferencias. Cloudflare opera una red global y su DPA contempla transferencias y
subprocesamiento; por tanto no se documentará el borde como "solo UE" salvo que un producto/configuración
contratada lo garantice expresamente.

Fuentes:
- https://supabase.com/legal/customer-resources/data-processing-addendum
- https://www.cloudflare.com/cloudflare-customer-dpa/
- https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/

Estado PRE-02/PRE-03: PARTIAL/BLOCKED. La arquitectura puede fijar el dato primario de Supabase en UE, pero
faltan la cuenta/entorno productivo, entidad contratante, proveedor de backup/journal y aceptación contractual
antes de usar datos reales.
