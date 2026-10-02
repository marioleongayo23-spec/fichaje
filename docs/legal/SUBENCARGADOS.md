# Inventario de subencargados (art. 28.2 y 28.4 RGPD) — PREPRODUCCIÓN H8

> Revisión 2026-10-02. Este inventario refleja la arquitectura realmente desplegada. La identidad legal del
> proveedor de Fichaje y los datos de cada Empresa siguen siendo campos contractuales a completar antes de
> tratar datos reales. No se confunde "proveedor publica DPA" con "contrato del primer cliente ya firmado".

| Proveedor / relación | Servicio | Datos tratados | Ubicación técnica | Marco contractual/transferencia verificado | Estado H8 |
|---|---|---|---|---|---|
| **Supabase Pte. Ltd** | PostgreSQL, Auth, Storage, Edge Functions | Datos de registro, identidades y evidencia descritos en el encargo | Proyecto productivo `eu-west-1` (Irlanda) | DPA v1 01/08/2026 integrado en Terms; subprocesadores y SCC módulos 2/3: https://supabase.com/legal/customer-resources/data-processing-addendum | Verificado como proveedor técnico; incorporar al anexo del cliente |
| **Amazon Web Services, Inc. y demás subprocesadores de Supabase** | Infraestructura/subservicios de Supabase | Según servicio de Supabase | Primariamente región seleccionada cuando aplica; soporte/subprocesadores según lista vigente | Cubiertos por obligaciones de subprocesador de Supabase; lista y cambios bajo su DPA | Verificar lista vigente en cada firma/cambio |
| **Cloudflare, Inc.** | Pages, TLS y borde `/gateway/*` | IP/cabeceras y cuerpos en tránsito; no se usa como archivo laboral | Red global | DPA v6.4 03/04/2026 para servicios self-service cuando actúa como processor/subprocessor; SCC: https://www.cloudflare.com/cloudflare-customer-dpa/ | Verificado como proveedor técnico; incorporar al anexo |
| **Databricks, Inc. (Neon)** | PostgreSQL independiente del journal de recuperación | UUID y metadatos de recuperación; sin nombres, fichajes, PIN ni motivos libres | `aws-eu-central-1` (Frankfurt) | Product Specific Schedule Neon 05/08/2026 + DPA/DTA Databricks y lista de subprocessors: https://neon.com/platform-terms / https://www.databricks.com/legal/dpa / https://www.databricks.com/legal/databricks-subprocessors | Verificado como proveedor técnico; incorporar al anexo |
| **Google Drive personal (My Drive)** | Offsite actual del backup DB cifrado age | Backup de la BD como ciphertext; clave privada fuera de Drive | Cuenta de consumidor; ubicación contractual no acreditada para este uso | El CDPA oficial se ofrece a clientes Workspace/Cloud Identity; no se ha acreditado su aplicación a este My Drive personal | **BLOCKED PARA DATOS REALES**; solo evidencia sintética H8 |
| **Google Drive personal (repo backup)** | Copia de bundles/snapshots de código | Sin datos de empleados por contrato de OPS-01 | Cuenta de consumidor | No se usa para datos personales laborales | Permitido mientras el artefacto siga sin datos personales |
| **GitHub, Inc.** | Código, CI y tickets WARNING | Sin datos laborales; fixtures sintéticos y alertas sin PII | Servicio global | No se clasifica como subencargado de datos laborales mientras se mantenga este contrato de minimización | Uso actual |
| **Email de Auth** | Confirmación/recuperación | Email de usuarios con cuenta | Según Supabase y sus subprocesadores mientras no exista SMTP propio | Cubierto dentro del servicio Supabase; cualquier SMTP propio futuro debe añadirse antes de uso | Sin proveedor SMTP adicional aprobado |
| **Ruta CRITICAL / WARNING** | Guardia y tickets operativos | Contrato `fichaje.alert.v1` prohíbe PII/secrets | Según proveedor operativo | Fuera del inventario de datos laborales mientras siga sin datos personales | GO-06 PASS; revisar si cambia el payload |

### Bloqueo previo al primer cliente
No se inicia tratamiento real hasta sustituir/acreditar el destino del backup DB y completar el encargo con:
identidad legal de Fichaje, identidad del responsable, canal de privacidad/DPD, plazo de aviso de cambios,
garantías aplicables y firmas.

Procedimiento de cambios: mantener autorización general escrita cuando se use; avisar a cada Empresa con
el plazo pactado, permitir oposición conforme al art. 28 RGPD y al DPA aplicable, actualizar este inventario
y conservar evidencia de la versión aceptada.
