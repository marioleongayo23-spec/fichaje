# Gestión de incidentes y violaciones de seguridad — PLANTILLA REVISABLE

> H7, 2026-09-28. Requisitos legales: el encargado notifica al responsable sin dilación indebida (art. 33.2
> RGPD); el responsable notifica a la autoridad de control en 72 horas salvo improbabilidad de riesgo (art. 33.1)
> y a los interesados si hay alto riesgo (art. 34); documentación de toda violación (art. 33.5). El ensayo de H7
> está en [`docs/drills/IR-2026-09-28.md`](../drills/IR-2026-09-28.md).

## Fases (decisión técnica y organizativa)
1. **Detección**: alertas (`docs/RUNBOOKS.md`), invariantes, canaries o comunicación externa. Abrir incidente
   `[[SISTEMA/REGISTRO]]` con hora UTC.
2. **Contención**: revocar dispositivos/membresías/credenciales afectadas (efecto inmediato en servidor),
   bloquear rutas afectadas; nunca modificar la historia laboral para "arreglar" el incidente.
3. **Preservación de evidencia**: auditoría, eventos operativos y alertas (sin PII) con su SHA-256; sin volcados
   de datos a canales no autorizados.
4. **Evaluación de afectados**: consultas por empresa (RLS), recuentos y alcance temporal; integridad verificada
   con invariantes y huellas de la historia.
5. **Notificación**: proveedor → Empresa en `[[PLAZO CONTRACTUAL]]` con la información del art. 33.3 disponible;
   la Empresa decide la notificación a la AEPD (72 h) y a interesados. Plantilla de comunicación: `[[…]]`.
6. **Recuperación**: restauración o redeploy seguro, canaries e invariantes en verde.
7. **Rotación de credenciales**: secretos de borde/funciones, claves de plataforma y credenciales afectadas.
8. **Reapertura autorizada** por `[[ROL]]` tras la validación.
9. **Postmortem** en `[[PLAZO]]`: causa, cronología, impacto, acciones; registro de violaciones.

Contactos: guardia `[[PAGER]]`; responsable de seguridad `[[…]]`; DPD proveedor `[[…]]`; DPD Empresa `[[…]]`.
