# Checklist de evaluación de impacto (EIPD, art. 35 RGPD) — PLANTILLA REVISABLE

> H7, 2026-09-28. La EIPD es obligación del **responsable** cuando el tratamiento entraña probablemente un alto
> riesgo (art. 35.1), considerando la lista de tratamientos de la AEPD (art. 35.4) — verificar la versión
> vigente de esa lista `[[REFERENCIA VERIFICADA]]`. El proveedor asiste (art. 28.3.f).

## 1. ¿Es necesaria? (marcar)
- [ ] Observación o control sistemático de personas (valorar: el registro es obligación legal y no mide
      actividad, pero afecta a toda la plantilla).
- [ ] Personas vulnerables o en situación de desequilibrio (personas trabajadoras frente a la empresa).
- [ ] Datos a gran escala `[[Nº PERSONAS]]`.
- [ ] Nuevas tecnologías o usos innovadores (V1 **excluye** biometría y geolocalización).
- [ ] Combinación o cruce con otros conjuntos de datos (nóminas, control de accesos) `[[…]]`.
- Conclusión y motivación: `[[EIPD NECESARIA SÍ/NO + MOTIVO]]`.

## 2. Si procede, contenido mínimo (art. 35.7)
- Descripción sistemática y finalidades (registro de jornada; ver [contrato](ENCARGO_TRATAMIENTO.md)).
- Necesidad y proporcionalidad: minimización (sin biometría/fotos/ubicación), plazo de 4 años, acceso por roles.
- Riesgos y medidas:

| Riesgo | Medida existente | Riesgo residual |
|---|---|---|
| Acceso no autorizado entre empresas | RLS forzada, pruebas cruzadas | `[[…]]` |
| Manipulación del registro | Originales inmutables, correcciones con decisión independiente, auditoría | `[[…]]` |
| Suplantación en kiosco (PIN compartido) | PIN aleatorio, límites 5/30/60, aceptación del riesgo por la Empresa | `[[…]]` |
| Uso para control de productividad | Fuera de V1; contrato limita la finalidad | `[[…]]` |
| Pérdida de datos | Backups cifrados, journal independiente, restore ensayado | `[[…]]` |
| Indisponibilidad | Contingencia en papel + correcciones; objetivos RPO/RTO del piloto | `[[…]]` |
| Transferencias | Ver [localización](LOCALIZACION_TRANSFERENCIAS.md) | `[[…]]` |

- Consulta a la representación legal `[[…]]`; opinión del DPD `[[…]]`; revisión `[[FECHA]]`.
