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
| 7 Piloto comercial | Staging, ensayo backups cifrados, recuperación, seguridad, documentos legales | OPS-02 PASS obligatorio; revisión independiente, CI integral, aceptación 1-2 empresas, aprobación de producción |

No crear infraestructura remota ni datos reales antes del hito autorizado. Backup DB solo se habilita
en cambio separado después de disponer de conexión segura, cifrado, custodia de claves y restore validado.
Los documentos de H0 especifican el destino; no acreditan implementación de hitos posteriores.
H7 queda bloqueado hasta que OPS-02 esté implementado y aprobado. OPS-02 se ejecuta después de H6 y antes del piloto con clientes reales.
