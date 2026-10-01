# GO-LIVE — puerta previa al primer cliente real

Estado inicial: **BLOCKED**. Esta puerta no autoriza datos reales ni producción por sí sola.

## Alcance

El producto funcional ya está cerrado en H7. GO-LIVE solo valida que la operación real pueda arrancar sin mezclar staging/producción, sin perder evidencia laboral y con obligaciones legales/operativas explícitas.

## Candidato productivo

- Supabase: proyecto `Fichaje APP`, ref `bypdviatamosygndeqhh`, región `eu-west-1`.
- Migración observada 2026-10-01: `20260930000200`, igual que staging.
- Estado observado: ACTIVE_HEALTHY.
- Datos tenant observados: 0 organizaciones, 0 memberships, 0 empleados, 0 fichajes.
- Storage: 1 bucket.
- No activar clientes reales hasta cerrar esta puerta.
- Los builds con `VITE_DEPLOYMENT_TIER=production` quedan ligados por código a ese proyecto y a gateways same-origin. Staging queda ligado a `pvfjffeszsedslmwdvgh`.

## Gates obligatorios

| ID | Gate | Estado inicial |
|---|---|---|
| GL-01 | CI, DB, E2E, OPS-02 y H7 verdes en el HEAD candidato | PENDING |
| GL-02 | Supabase Security Advisor revisado; findings intencionados documentados y sin hallazgos críticos sin resolver | PARTIAL |
| GL-03 | Producción vacía antes del primer alta y migraciones alineadas con staging | PASS |
| GL-04 | Build productivo no puede apuntar a staging ni a gateways externos | IMPLEMENTED; pendiente CI |
| GL-05 | Ruta de alerta real operativa y probada con un evento sintético, sin PII | PASS — GitHub Issues privado; run 36881276163; issues sintéticos #22/#23 cerrados |
| GL-06 | Backup DB real cifrado + custodia de clave fuera del destino + restore probado en entorno vacío | PARTIAL — destino privado candidato creado; falta credencial DB, clave age offline y restore real |
| GL-07 | Journal de recuperación independiente operativo y reconciliable | BLOCKED — diseño validado; la integración no permite aprovisionar de forma segura la credencial SQL entre proyectos |
| GL-08 | Runbook de incidente con responsable, corte de escrituras, restore/reapertura y contacto de brechas | PARTIAL |
| GL-09 | Revisión normativa vigente, contrato de encargo/subencargados y documentación de información a plantilla disponibles para el primer cliente | PARTIAL |
| GL-10 | Control de procedencia de release: branch protection si el plan lo permite o gate equivalente que rechace cualquier SHA que no sea HEAD de `main`, merge de PR y 5/5 checks verdes | IMPLEMENTED; pendiente CI |
| GL-11 | Deploy final de Cloudflare separado de staging, con CSP/HSTS/gateway firmado y release verificable | BLOCKED |
| GL-12 | Autorización expresa del usuario para activar producción | BLOCKED |

No se declara PASS si cualquiera de GL-01..12 sigue PENDING/BLOCKED/PARTIAL.

### Compensación GitHub Free
El repositorio es privado y GitHub Free no ofrece protected branches/rulesets para repositorios privados. No se hará público el código ni se contratará GitHub Pro solo por este gate. Como control compensatorio, `.github/workflows/production-candidate.yml` solo empaqueta un candidato productivo cuando:
- el SHA solicitado es exactamente el HEAD actual de `main`;
- ese SHA es el merge commit de exactamente un PR mergeado contra `main`;
- CI, Database, E2E H6, OPS-02 y H7 constan `completed/success` para ese mismo SHA;
- el build usa el Supabase productivo fijado y pasa el escáner de secretos.

Un push directo a `main` puede existir técnicamente en GitHub Free, pero no puede convertirse en artefacto productivo mediante el flujo autorizado.

## Seguridad

Los avisos del Supabase Security Advisor sobre RPC `SECURITY DEFINER` no se silencian mecánicamente: estas funciones son parte del contrato de autorización servidor y solo pueden mantenerse si sus GRANT, comprobaciones de actor/tenant, RLS y tests siguen verdes. Un warning nuevo distinto o una regresión de permisos bloquea GO-LIVE.

No se guardan secretos en GitHub. La clave privada de backup no puede residir junto al backup ni en el repositorio. Los datos reales no se usan para canaries, tests ni restore drills.

## Backup y coste

Supabase documenta backups diarios automáticos para Pro/Team/Enterprise; en Free recomienda exportaciones periódicas con CLI y copias off-site. Por tanto, el plan Free actual **no satisface por sí solo GL-06**. Antes del primer cliente se necesita una de estas dos vías:

1. backup lógico cifrado y automatizado fuera de Supabase, con clave custodiada separadamente y restore real probado; o
2. plan gestionado que incluya backup adecuado, igualmente con restore probado y política de Storage.

No se contratará un plan ni add-on sin autorización expresa.

## Revisión legal 2026-10-01

- Vigente: art. 34.9 ET exige registro diario con inicio/fin, conservación 4 años y disponibilidad para trabajador, representación legal e Inspección.
- AEPD: el registro horario ordinario no necesita consentimiento del trabajador cuando se basa en obligación legal, pero sí información sobre el tratamiento.
- El Proyecto de Ley 121/000058 sobre reducción de jornada y garantía del registro digital fue devuelto/rechazado por el Congreso el 10-09-2025; sus requisitos adicionales no se tratan como ley vigente.
- Antes del primer cliente hay que revisar además su convenio colectivo y el caso concreto.

Fuentes: BOE-A-2015-11430; AEPD FAQ 0311; Congreso iniciativa 121/000058.

## Salida

GO-LIVE solo pasa cuando todos los gates están acreditados en `CURRENT_STATE.md` con evidencia verificable. Después requiere una orden explícita y posterior del usuario para merge y otra autorización explícita para activar producción real si aún no se hubiera dado.


### Evidencia GL-05 — ruta real sin coste
El run `36881276163` ejecutó el mismo adaptador `GitHubIssueNotifier` con el `GITHUB_TOKEN` efímero de Actions y permiso mínimo `issues: write`. Se probaron en entorno lógico `production`:
- CRITICAL `APP_DOWN`: issue #22 abierto y cerrado al resolver;
- WARNING `INVARIANT_WARNING`: issue #23 abierto y cerrado al resolver;
- ambos con etiqueta `fichaje-alert`, sin datos de empresa, empleado, PIN, email ni payload laboral;
- no se guarda token propio ni secret de GitHub.

Se corrigieron dos defectos detectados por la prueba real: validación demasiado rígida del formato del token y carrera de consistencia del listado de Issues tras crear/Resolver inmediatamente. La ruta quedó probada después de ambas correcciones.

### Preparación GL-06 — coste 0
Se creó en el Drive privado existente `Fichaje APP - BACKUP` la carpeta `02 - DB Encrypted Backups` como **destino candidato**, no autorizado todavía para datos reales. El script existente `scripts/backup_database.sh` ya exige `pg_dump | age`, TLS verify-full, ficheros 0600 y ausencia de la clave privada age en el host/destino.

El gate no pasa aún: falta ejecutar un backup del candidato productivo con credencial de solo lectura, custodiar la identidad privada age fuera del destino y restaurar ese backup en un entorno vacío. No se sustituye esta prueba por documentación ni por un checksum.
