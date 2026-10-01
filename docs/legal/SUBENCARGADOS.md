# Inventario de subencargados (art. 28.2 y 28.4 RGPD) — PLANTILLA REVISABLE

> H7, 2026-09-28. Los proveedores listados son los que la **arquitectura técnica** usa o puede usar; su
> condición contractual real (entidad firmante, DPA, región contratada, certificaciones y garantías de
> transferencia) **no se ha verificado** desde el entorno de H7 y debe completarse con la documentación vigente
> de cada proveedor antes del piloto. No se han rellenado datos ficticios.

| Proveedor (entidad contratante) | Servicio | Datos personales tratados | Región / ubicación | Garantía de transferencia | DPA firmado | Estado |
|---|---|---|---|---|---|---|
| `[[ENTIDAD SUPABASE CONTRATANTE]]` | Base de datos PostgreSQL, Auth, Storage, Edge Functions | Todos los del registro (ver contrato de encargo) | `[[REGIÓN UE DEL PROYECTO]]` | `[[DPF / CCT / N.A.]]` | `[[SÍ/NO + FECHA]]` | Pendiente de verificación |
| `[[SUBENCARGADO DE HOSTING DE SUPABASE, p. ej. proveedor cloud]]` | Infraestructura subyacente de Supabase | Los mismos, cifrados en reposo según el proveedor | `[[REGIÓN]]` | `[[…]]` | Vía Supabase | Pendiente de verificación |
| `[[ENTIDAD CLOUDFLARE CONTRATANTE]]` | Cloudflare Pages (estáticos y función de borde `/gateway/*`), TLS, protección de red y WAF | Metadatos de conexión (IP, cabeceras) y cuerpos en tránsito hacia las funciones; no almacena registros laborales | Red global (procesamiento en el punto de presencia más cercano) | `[[DPF / CCT]]` | `[[…]]` | Pendiente de verificación |
| `[[PROVEEDOR SMTP / EMAIL DE AUTH]]` | Emails de Auth (confirmación, recuperación) | Email de la persona usuaria | `[[…]]` | `[[…]]` | `[[…]]` | Pendiente de decisión |
| `[[PROVEEDOR DE PAGER, p. ej. PagerDuty]]` | Alertas CRITICAL | Ninguno (alertas sin PII por contrato `fichaje.alert.v1`) | `[[…]]` | N.A. (sin datos personales) | `[[…]]` | Pendiente de decisión |
| GitHub (`[[ENTIDAD]]`) | Código fuente, CI, tickets de alertas WARNING (repositorio privado) | Ninguno de empleados (código, datos sintéticos de prueba, alertas sin PII) | `[[…]]` | N.A. | `[[…]]` | Uso actual sin datos personales |
| Google Drive (`[[ENTIDAD]]`) | Copia secundaria del repositorio (OPS-01) | Ninguno (código) | `[[…]]` | N.A. | `[[…]]` | Uso actual sin datos personales |
| `[[DESTINO DEL BACKUP CIFRADO DE BASE DE DATOS]]` | Copias lógicas cifradas con age (35 días) | Todos, **cifrados** (la clave privada no está en el proveedor) | `[[REGIÓN UE]]` | `[[…]]` | `[[…]]` | Pendiente de decisión (H7 BLOCKED) |
| `[[INSTANCIA DEL JOURNAL DE RECUPERACIÓN]]` | Registro independiente de bajas, retenciones y purgas | Identificadores técnicos y metadatos de recuperación (sin nombres, fichajes ni motivos) | `[[REGIÓN UE]]` | `[[…]]` | `[[…]]` | Pendiente de decisión (H7 BLOCKED) |

Procedimiento de cambios: aviso a cada Empresa con `[[PLAZO PREAVISO]]`; derecho de oposición; actualización
de este inventario (versión y fecha) y del anexo del contrato. Evaluación anual de cada subencargado:
`[[RESPONSABLE]]`.


## Verificación PREPROD-01 — 2026-10-01

Fuentes oficiales verificadas:
- Supabase DPA vigente (versión 1, 2026-08-01):
  https://supabase.com/legal/customer-resources/data-processing-addendum
- Supabase lista de subencargados:
  https://supabase.com/legal/customer-resources/subprocessor-list
- Cloudflare DPA v6.4 (2026-04-03):
  https://www.cloudflare.com/cloudflare-customer-dpa/
- Cloudflare lista de subencargados:
  https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/

Hallazgos útiles para contratación:
- Supabase declara rol processor/subprocessor según la cadena contractual, autorización general de
  subencargados y SCC para transferencias cuando proceda. Su lista incluye, entre otros, AWS y Cloudflare
  para determinadas funciones del servicio.
- Cloudflare mantiene DPA y lista pública de subencargados con aviso previo de cambios.
- Estas fuentes permiten completar la parte técnica del inventario, pero **no** sustituyen identificar la
  entidad que contrata realmente la cuenta de Fichaje, aceptar/archivar el DPA aplicable y documentar la
  garantía de transferencia concreta al firmar con el cliente.

Estado PRE-02: PARTIAL. Proveedores principales verificados documentalmente; siguen pendientes entidad
contratante real de Fichaje, SMTP, alertas, backup/journal y revisión jurídica del anexo comercial.
