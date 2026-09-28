# Baja de cliente, devolución y supresión — PLANTILLA REVISABLE

> H7, 2026-09-28. Requisito legal: al terminar el encargo, el encargado suprime o devuelve los datos a elección
> del responsable, salvo conservación exigida por el Derecho (art. 28.3.g RGPD). La Empresa debe conservar el
> registro cuatro años (art. 34.9 ET): la devolución completa es previa a cualquier supresión.

1. **Aviso de baja** por `[[CANAL]]`; fecha efectiva `[[FECHA]]`.
2. **Exportación final**: todas las personas y periodos (CSV + JSON + PDF, digest SHA-256), con corte
   consistente; entrega controlada con recibo a `[[RECEPTOR]]`.
3. **Opción de custodia** (si se contrata): conservación bloqueada hasta `[[FECHA]]` con acceso solo para
   entregas a la Empresa, Inspección o autoridades (art. 32 LOPDGDD, bloqueo) — `[[CONDICIONES]]`.
4. **Revocación de accesos**: membresías, dispositivos de kiosco (revocación inmediata) y credenciales técnicas.
5. **Supresión** en la base activa en `[[PLAZO]]` mediante el proceso de purga autorizado (manifiesto con
   recuentos, sin contenido), registrada en el journal de recuperación para que un restore posterior no
   reintroduzca los datos.
6. **Copias cifradas**: desaparecen por rotación a los 35 días (decisión técnica); no se restauran como vigentes.
7. **Certificado de supresión** a la Empresa `[[MODELO]]`.
