# Documentación legal y comercial del piloto — índice (HITO 7)

Preparada el 2026-09-28. **Son plantillas revisables, no asesoramiento jurídico** ni una declaración de
cumplimiento. No se han inventado datos de empresas, proveedores ni plazos: todo dato real se marca con
`[[MARCADOR]]` y debe completarlo y validarlo la asesoría jurídica del proveedor y de cada empresa piloto.
La revisión normativa y sus límites (fuentes primarias no accesibles desde el entorno de ejecución de H7)
están en [`docs/COMPLIANCE.md`](../COMPLIANCE.md).

Reparto de papeles asumido (a validar en cada contrato): la **empresa cliente es responsable del
tratamiento** del registro de jornada (obligación legal del art. 34.9 ET, base jurídica art. 6.1.c RGPD);
**el proveedor de Fichaje es encargado del tratamiento** (art. 28 RGPD). Distinguimos siempre:
**requisito legal** (norma citada), **decisión técnica** del producto y **decisión de la empresa**.

| Documento | Uso |
|---|---|
| [Contrato de encargo de tratamiento](ENCARGO_TRATAMIENTO.md) | Art. 28 RGPD; anexo de medidas técnicas |
| [Inventario de subencargados](SUBENCARGADOS.md) | Art. 28.2 y 28.4 RGPD |
| [Localización de datos y transferencias](LOCALIZACION_TRANSFERENCIAS.md) | Arts. 44–49 RGPD |
| [Información a las personas trabajadoras](INFORMACION_EMPLEADOS.md) | Art. 13 RGPD; art. 34.9 ET |
| [Acceso de la persona trabajadora a su registro](ACCESO_TRABAJADOR.md) | Art. 34.9 ET; art. 15 RGPD |
| [Procedimiento para representantes](REPRESENTANTES.md) | Art. 34.9 ET |
| [Procedimiento para la Inspección de Trabajo](INSPECCION.md) | Art. 34.9 ET |
| [Contingencia: sistema no disponible](CONTINGENCIA.md) | Continuidad del registro |
| [Personas trabajadoras sin email](SIN_EMAIL.md) | Kiosco, entrega de PIN y copias |
| [Baja de cliente, devolución y supresión](BAJA_CLIENTE.md) | Art. 28.3.g RGPD |
| [Ejercicio de derechos](DERECHOS.md) | Arts. 12–22 RGPD |
| [Incidentes y violaciones de seguridad](INCIDENTES.md) | Arts. 33–34 RGPD |
| [Política de retención](RETENCION.md) | Art. 5.1.e RGPD; art. 34.9 ET; art. 32 LOPDGDD |
| [Checklist de convenio y pausas](CHECKLIST_CONVENIO_PAUSAS.md) | Configuración por empresa |
| [Checklist de EIPD](CHECKLIST_EIPD.md) | Art. 35 RGPD |
| [Checklist de alta y baja de empresa piloto](CHECKLIST_ONBOARDING_OFFBOARDING.md) | Operación del piloto |

Ámbito del producto V1 (limita lo que prometen estos documentos): entrada, pausa, fin de pausa y salida;
correcciones con aprobación independiente; exportaciones CSV/JSON/PDF; kiosco con código + PIN. **Sin**
biometría, fotografías, geolocalización, nóminas, vacaciones, control de productividad ni planificación
compleja de turnos.
