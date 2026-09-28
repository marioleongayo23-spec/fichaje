# Política de retención — PLANTILLA REVISABLE

> H7, 2026-09-28. Requisito legal: conservación del registro durante cuatro años (art. 34.9 ET; también arts.
> 12.4.c y 35.5 cuando apliquen); limitación del plazo (art. 5.1.e RGPD); bloqueo (art. 32 LOPDGDD). Los plazos
> técnicos son **decisiones técnicas revisables**, marcadas como tales.

| Categoría | Plazo | Naturaleza |
|---|---|---|
| Fichajes, sesiones, correcciones, decisiones, clasificaciones y su evidencia | Mínimo 4 años desde el cierre del periodo; prorrogable por legal hold | Requisito legal (+ ampliación por correcciones: decisión técnica) |
| Identificación mínima de empleado/autor ligada a la evidencia | Igual que la evidencia | Minimización |
| Claves de idempotencia de negocio | Igual que la evidencia | Decisión técnica |
| Registros de seguridad sin evidencia laboral | 90 días | Decisión técnica |
| Challenges y contadores de kiosco | 60 s / 15 min de ventana; purga en 24 h | Decisión técnica |
| Exportaciones temporales | 24 h; enlace firmado 5 min | Decisión técnica |
| Backups cifrados de base de datos | Rotación móvil de 35 días | Decisión técnica (recuperación, no archivo legal) |
| Telemetría agregada del navegador | 7 días | Decisión técnica |
| Backups del repositorio | 14 días en CI; Drive según OPS-01 | Sin datos personales |

Supresión: por proceso autorizado con manifiesto (recuentos, sin contenido), nunca por botón de usuario;
registrada en el journal de recuperación. Revisión trimestral de holds `[[RESPONSABLE]]`.
