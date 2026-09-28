# Personas trabajadoras sin email — PLANTILLA REVISABLE

> H7, 2026-09-28. Requisito: nadie queda fuera del registro ni de su consulta por no tener email. Decisiones
> técnicas del producto: kiosco sin email con código + PIN, sin cuentas ficticias compartidas.

1. **Alta**: la persona gestora crea la ficha de empleado sin cuenta; asigna horario.
2. **PIN**: el servidor genera un PIN aleatorio de 8 dígitos; la aplicación lo muestra **una vez** a la persona
   gestora, cifrado de extremo a extremo hasta su navegador, para entregarlo **en mano**; no se envía por
   email, SMS ni mensajería. El PIN no se puede recuperar; se restablece (queda auditado).
3. **Fichar**: en el kiosco con código + PIN; el kiosco solo muestra las acciones válidas y confirma tras la
   respuesta del servidor; limpia la pantalla antes de 15 s. El PIN reduce la fricción pero no prueba presencia
   física: la Empresa acepta este riesgo y su procedimiento `[[ACEPTACIÓN FIRMADA]]`.
4. **Consulta y copia**: copia impresa o descarga asistida individual ([acceso](ACCESO_TRABAJADOR.md)); nunca
   se expone el directorio en el kiosco.
5. **Correcciones**: solicitud asistida por una persona gestora identificando a la persona con el mismo método;
   la decide otra persona gestora.
6. **Baja**: desactivar la ficha (no borra el historial) y, si procede, restablecer PIN de kioscos compartidos.
