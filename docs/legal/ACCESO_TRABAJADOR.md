# Acceso de la persona trabajadora a su registro — PLANTILLA REVISABLE

> H7, 2026-09-28. Requisito legal: el registro permanece a disposición de las personas trabajadoras (art. 34.9
> ET); derecho de acceso (art. 15 RGPD). Plazos internos `[[…]]` a fijar por la Empresa.

| Situación | Cómo (decisión técnica del producto) | Evidencia |
|---|---|---|
| Con cuenta | "Mi registro" (originales, correcciones aprobadas, sesiones abiertas como incidencia y totales informativos) y "Exportar mi registro" (CSV + JSON + PDF con digest SHA-256) | Exportación y auditoría |
| Sin email | Copia impresa o descarga asistida en `[[LUGAR/RESPONSABLE]]`: la persona gestora genera la exportación **solo** de esa persona; nunca se muestra el directorio en el kiosco | Entrega controlada con recibo |
| Discrepancia | Solicitud de corrección con motivo; decide otra persona gestora; el original se conserva | Decisión append-only |

Pasos para la persona gestora (sin email):
1. Verificar la identidad de la persona solicitante `[[MÉTODO]]`.
2. Exportar el periodo solicitado desde Exportaciones (empleado concreto, rango local).
3. Entregar en mano o por el canal acordado; registrar la entrega controlada (alcance y receptor).
4. Responder en `[[PLAZO INTERNO; máximo legal art. 12.3 RGPD: un mes ampliable]]`.
