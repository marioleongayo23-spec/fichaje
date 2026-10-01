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
| GO-LIVE Producción | Aislamiento staging/prod, alertas reales, backup/restore, journal, incidente, revisión legal/seguridad, control de procedencia de release y deploy productivo | Todos los GL-01..12 de `docs/GO_LIVE.md` acreditados; autorización expresa antes de merge/activación |

No crear infraestructura remota ni datos reales antes del hito autorizado. Backup DB solo se habilita
en cambio separado después de disponer de conexión segura, cifrado, custodia de claves y restore validado.
Los documentos de H0 especifican el destino; no acreditan implementación de hitos posteriores.
H7 queda bloqueado hasta que OPS-02 esté implementado y aprobado. OPS-02 se ejecuta después de H6 y antes del piloto con clientes reales.

## Decisión de alcance H7 — 2026-09-29
H7 ya no incluye un piloto con 1-2 empresas reales ni exige contratar infraestructura adicional para simulacros.
La aceptación final del producto se hará sobre la app desplegada con una **empresa ficticia y datos exclusivamente sintéticos**, cubriendo OWNER/ADMIN/EMPLOYEE, kiosco, ciclo horario, correcciones, informes/exportación y aislamiento multiempresa.

Los controles operativos que solo aportan valor al operar con clientes reales —rutas de alerta de guardia, backup/restore gestionado en un segundo entorno, simulacro de incidente y compromisos RPO/RTO— **no se eliminan**: se trasladan a la puerta previa al **primer cliente real / activación de producción**. No se contratará Supabase Pro ni otra infraestructura de pago solo para cerrar H7; cualquier gasto futuro requiere autorización expresa y justificación por ingresos o riesgo real.

## GO-LIVE — 2026-10-01
H7 está cerrado. La única fase abierta es la puerta operativa de producción definida en `docs/GO_LIVE.md`.
No se considera comercializable con datos reales hasta que esa puerta esté PASS.
