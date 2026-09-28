# Procedimiento de acceso de la representación legal — PLANTILLA REVISABLE

> H7, 2026-09-28. Requisito legal: el registro está a disposición de la representación legal de las personas
> trabajadoras (art. 34.9 ET). El **alcance** (individual/agregado, periodicidad, soporte) lo decide la Empresa con
> su asesoría y, en su caso, el convenio o acuerdo: `[[CRITERIO JURÍDICO DE LA EMPRESA]]`.

Decisión técnica: no existe un "cuarto rol" en la aplicación. La representación **no** recibe cuentas con acceso
libre; recibe **entregas controladas** que genera una persona gestora.

1. Solicitud de la representación por `[[CANAL]]`, indicando periodo y alcance.
2. La persona gestora genera la exportación (empresa o personas concretas, periodo), con corte consistente y
   digest SHA-256.
3. Registra la entrega controlada (receptor, alcance, fecha) en la aplicación; el recibo queda auditado.
4. Entrega por `[[CANAL SEGURO]]`; los enlaces firmados caducan a los 5 minutos y los ficheros temporales a las
   24 h (decisión técnica); no se envían enlaces públicos.
5. Registro de la entrega en `[[REGISTRO INTERNO]]`. Plazo de respuesta: `[[PLAZO]]`.
