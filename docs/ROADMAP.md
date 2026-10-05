# Roadmap — cada hito requiere aprobación independiente
| Hito | Alcance | Puerta de salida |
|---|---|---|
| 0 Bootstrap | Documentos, esqueleto, CI, scripts backup manual | Checks locales y CI verdes, restore repo probado, PR revisable; sin producción |
| 1 Identidad y aislamiento | Migraciones, Auth, tenants, membresías, roles, RLS y políticas | Pruebas DB reales cruzadas, anon, revocación, FK, OWNER mínimo; sin interfaz visual |
| 2 Motor horario | RPC, eventos, estado, reloj, idempotencia, locks, auditoría | Matriz completa, rollback, concurrencia real, DST y timeouts |
| 3 Correcciones | Solicitud/decisión/ajustes append-only, replay y clasificaciones | Original intacto, no autoaprobación, revisiones obsoletas y límites válidos |
| 4 Kiosco | Dispositivo, PIN, rate limit, challenge, revocación | Ataques/replay/carreras y usuarios sin email superados |
| 5 Informes y retención | CSV/JSON/PDF, cortes consistentes, acceso, retención y holds | Entrega mensual, inyección, aislamiento export, purga y restore coherentes |
| 6 UX/PWA | Solo tras autorización expresa y aprobación de lógica H1-H5 | Accesibilidad, pruebas navegador, no cache sensible, offline seguro |
| OPS-02 Observabilidad y resiliencia | Telemetría, health checks, canaries sintéticos, invariantes, alertas, rollback y self-healing seguro | Fallos inducidos detectados; rollback/retry seguro probado; backups vigilados; ningún mecanismo automático reescribe datos laborales originales |
| 7 Cierre del producto y validación sintética final | App final desplegada, empresa ficticia completa, seguridad, recuperación y documentación legal | OPS-02 PASS obligatorio; CI integral; verificación remota; flujo E2E completo con empresa ficticia; aprobación del usuario. Sin empresa real ni producción |
| 8 GO-LIVE / producción | Candidato productivo, release gate, alertas, recuperación operativa, incidente, legal y gobierno | GO-01..10 PASS, 0 datos reales durante la validación y autorización expresa posterior antes del primer cliente |
| 9 Integración visual del socio | Sustituir únicamente la presentación por el diseño exacto entregado por el socio, preservando contratos y lógica H1-H8 | Fuente visual exacta trazable; diff sin cambios backend/DB/security; responsive y accesibilidad; CI + Database + E2E H6 + OPS-02 + H7 5/5 PASS; aprobación del usuario |\n| 10 Fidelidad visual Bundy y despliegue final | Corregir la fidelidad visual real de login/onboarding/app usando PDF + logos + web comercial y acreditar el release online | Sin cambios backend/DB/security; sesión limpia muestra login Bundy; comparación visual; 5/5 PASS mismo HEAD; staging/URL final sirven ese release; aprobación posterior |\n| 11 Réplica visual Bundy | Reproducir la composición del PDF de app móvil con fidelidad de pantalla, preservando funciones V1 y contratos H1-H10 | Comparación directa con PDF; frontend-only; sin funciones ficticias; 5/5 PASS mismo HEAD; aprobación posterior |

No crear infraestructura remota ni datos reales antes del hito autorizado. Backup DB solo se habilita
en cambio separado después de disponer de conexión segura, cifrado, custodia de claves y restore validado.
Los documentos de H0 especifican el destino; no acreditan implementación de hitos posteriores.
H7 queda bloqueado hasta que OPS-02 esté implementado y aprobado. OPS-02 se ejecuta después de H6 y antes del piloto con clientes reales.


## Decisión de alcance H7 — 2026-09-29
H7 ya no incluye un piloto con 1-2 empresas reales ni exige contratar infraestructura adicional para simulacros.
La aceptación final del producto se hará sobre la app desplegada con una **empresa ficticia y datos exclusivamente sintéticos**, cubriendo OWNER/ADMIN/EMPLOYEE, kiosco, ciclo horario, correcciones, informes/exportación y aislamiento multiempresa.

Los controles operativos que solo aportan valor al operar con clientes reales —rutas de alerta de guardia, backup/restore gestionado en un segundo entorno, simulacro de incidente y compromisos RPO/RTO— **no se eliminan**: se trasladan a la puerta previa al **primer cliente real / activación de producción**. No se contratará Supabase Pro ni otra infraestructura de pago solo para cerrar H7; cualquier gasto futuro requiere autorización expresa y justificación por ingresos o riesgo real.


## HITO 8 — GO-LIVE / producción
H8 empieza únicamente tras H7 aprobado e integrado. El candidato se valida primero con datos
sintéticos y no se considera producción comercial por existir o por responder HTTP.

La puerta completa está en `docs/PRODUCTION.md`. H8 no puede rebajar controles para conservar
coste 0: si una alerta de guardia, backup/restore aislado, requisito contractual o control de
plataforma no puede acreditarse sin coste, se declara BLOCKED y se solicita autorización antes
de contratar. El merge del PR y la activación para clientes requieren aprobación expresa posterior.


## HITO 9 — integración visual del socio
H9 comienza tras H8 aprobado e integrado. Su alcance es exclusivamente visual: la fuente entregada por el socio es autoritativa y no se reinterpretará. No se permiten cambios en backend, SQL/RLS/RPC, seguridad, lógica horaria, idempotencia, auditoría, Stripe ni semántica PWA. La salida exige demostrar por diff y regresión completa que la lógica validada permanece intacta.


## HITO 10 — fidelidad visual Bundy + despliegue final
H10 corrige exclusivamente la presentación y la acreditación del despliegue tras comprobar que H9 no alcanzó la fidelidad visual esperada por el usuario. El PDF/logos oficiales y la web comercial Bundy son la referencia. No se incorporan comportamientos promocionados en la web que estén fuera de V1. El cierre exige además comprobar de forma remota que la URL publicada sirve el mismo release validado.


## HITO 11 — réplica visual Bundy
H11 parte de H10 ya integrado y usa el PDF entregado como referencia visual estricta, no como mera inspiración. La composición móvil, proporciones, navegación, CTA, tarjetas y jerarquía deben aproximarse directamente a las pantallas 01, 03, 04 y 05. Las funciones no presentes en V1 no se implementan ni simulan; en particular, no se añade geolocalización. No hay cambios backend/DB/security.
