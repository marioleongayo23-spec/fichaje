# Backup y recuperación
## Estado tras OPS-01
El repositorio genera un backup privado automáticamente cada día a las 01:30 UTC y también permite
ejecución manual. GitHub Actions conserva el artefacto 14 días. El workflow no conoce credenciales
de Google Drive ni ejecuta backup PostgreSQL. Una automatización externa de ChatGPT copia el último
artefacto válido al Drive privado del proyecto después de la ejecución nocturna.
`backup_database.sh` terminaba 2 incondicionalmente en OPS-01. **H7** lo implementa (ver la sección H7): sigue
terminando 2 (`BLOCKED`) mientras falte cualquier condición y no está programado en ningún workflow ni host.

## Repositorio
En clon limpio completo: `git fetch origin --prune --tags '+refs/heads/*:refs/remotes/origin/*'`,
`bash scripts/backup_repo.sh /ruta/privada/backups`. Rechaza shallow y cambios sin commit.
Workflow checkout fetch-depth:0 recupera todas las ramas/tags; bundle --all conserva referencias
locales/remotas y sus objetos/historial alcanzable. No conserva commits ya borrados y no alcanzables,
reflogs remotos, issues/PR/comentarios, Secrets, configuración GitHub, LFS ni submódulos externos.
H0 no usa LFS/submódulos; si se incorporan, ampliar procedimiento antes de depender del backup.
Snapshot usa git archive HEAD: solo versión confirmada, excluye untracked/ignorados y .git.
Genera directory único con repository.bundle, snapshot.tar.gz, manifest.txt, refs.txt y SHA256SUMS.
`git bundle verify` + checksums antes de dar éxito; error elimina salida parcial local.
Rclone copy --immutable y check --download verifican upload; nunca sync ni borrado remoto.
Un fallo remoto puede dejar directorio parcial: no considerarlo recuperable hasta validar SHA256SUMS.

## Copia secundaria en Google Drive
Destino privado: `Fichaje APP - BACKUP/01 - Repo Snapshots`. GitHub Actions no recibe tokens de
Google: genera y verifica el bundle/snapshot y lo publica como artefacto privado temporal. Una
automatización de ChatGPT, usando las conexiones autorizadas de GitHub y Google Drive, descarga el
último artefacto exitoso y lo sube a esa carpeta, conservando el ZIP de artefacto como unidad de
recuperación. Debe verificar metadata de Drive tras la subida y avisar si falta un backup exitoso.
No usar `sync`, no borrar copias remotas automáticamente y no almacenar credenciales en el repo.
Rotación objetivo futura: 30 diarios + 12 mensuales según COMPLIANCE; actualmente sin purga automática.

## Restore del código
En ubicación aislada y con Git disponible:
1. Recuperar directorio, ejecutar `sha256sum -c SHA256SUMS` dentro de él.
2. `git bundle verify repository.bundle` desde un repo git temporal inicializado.
3. `git clone --mirror /ruta/repository.bundle restored.git`; comparar refs con refs.txt.
4. `git --git-dir=restored.git fsck --full`; comprobar SHA de manifest y historial de main/ramas/tags.
5. Clonar restored.git a working tree, checkout SHA del manifest; `npm ci && npm run check`.
6. Snapshot: `tar -tzf snapshot.tar.gz` antes de extraer en carpeta vacía; es fuente legible, no historial.
7. Reponer remoto/configuración/secrets por canales seguros. Push de restauración solo tras autorización;
   jamás ejecutar mirror push a un repo vivo sin revisar impacto.
Ensayo H0 automatizado sobre repositorios sintéticos: otra rama, tag y varios commits recuperables.
No afirma haber ensayado restauración del repositorio remoto completo del usuario.

## Diseño de backup PostgreSQL (inactivo)
Antes de activar: región/contrato, conexión dedicada TLS verify-full con CA, cliente pg_dump compatible,
credenciales en Secrets, receptor age público y clave privada custodiada fuera de GitHub/Drive,
destino privado, cuota, alertas y rotación aprobados. Sin backup en artefactos generales de Actions.
Futuro pipeline: pg_dump custom → age → fichero temporal cifrado, con pipefail; renombrar solo al éxito,
checksum de ciphertext y upload verificado. Ningún dump plano a disco, log o Drive. Prueba de descifrado
y restore aislado obligatorio: checksum de ciphertext no demuestra que la base se pueda restaurar.
Cifrar también configuración exportada sensible; conservar claves durante toda retención del backup.
Alcance explícito: tablas/RLS/funciones/triggers de aplicación, datos Auth necesarios, políticas Storage;
objetos Storage por separado. Roles gestionados, extensiones, claves de firma Auth, SMTP y settings del
proveedor no se recuperan de un simple pg_dump. Restaurar con procedimientos compatibles Supabase,
no reemplazar roles gestionados sin evaluación. Validar Auth con sesiones revocadas y rotar claves si incidente.

## OPS-02 — detección y autorrecuperación
Antes del piloto, la operación debe vigilar disponibilidad y errores de frontend/API/Auth/PostgreSQL, latencia del fichaje, fallos de jobs y frescura/éxito de backups. Un backup fallido, ausente o no verificable genera alerta; éxito de upload no equivale a restore probado.

Recuperaciones automáticas admitidas: retry idempotente con la misma clave, reinicio/redeploy de servicios, rollback a release previamente sana, reintento de jobs y reconstrucción de proyecciones reconstruibles desde eventos/ajustes inmutables. Deben ser acotadas, observables y repetibles. Nunca modificar automáticamente `time_events`, correcciones aprobadas ni horas efectivas para "arreglar" una inconsistencia.

En staging se inducirá al menos una release degradada/fallo controlado para demostrar: detección, alerta, preservación de evidencia, rollback y retorno del canary a verde. Una deriva de invariantes bloquea auto-reparaciones no expresamente autorizadas y escala a revisión humana.

Implementado en OPS-02 (2026-09-26), probado en un arnés CI aislado y efímero: gate de release con
rollback automático a la última release sana (`scripts/ops/release_gate.py`), reintentos idempotentes y
circuito (`retry.py`, `jobs.py`), reconstrucción autorizada de `employee_state` (`rebuild_projection.py`,
`--check` de solo lectura, `--apply` con referencia de autorización, BLOCKED si la fuente es incoherente)
y monitor de backups (`backup_monitor.py`, diario en `.github/workflows/ops-monitor.yml`): último run,
conclusión, artefacto, `SHA256SUMS`, `git bundle verify`, restore de ensayo del bundle y frescura ≤ 26 h.
PostgreSQL permanece `NOT_CONFIGURED` y nunca en verde hasta el ensayo cifrado de H7. Procedimientos por
alerta en `docs/RUNBOOKS.md`. El ensayo en staging sigue siendo puerta de H7.

## Restore DB futuro / puerta H7
1. Contener incidente, parar escrituras, preservar evidencia y seleccionar punto consistente.
2. Verificar checksum; descifrar en stream hacia pg_restore en entorno aislado compatible, sin acceso público.
3. Reponer migraciones/roles/configuración/objetos Storage según inventario versionado; verificar RLS,
   constraints, triggers de inmutabilidad, secuencias, conteos y reconciliación eventos/proyecciones.
4. Reaplicar holds, bajas y purgas posteriores desde registro de recuperación externo autorizado.
5. Ejecutar suite de tenants/roles, idempotencia, kiosco y exportaciones con datos de prueba.
6. Medir pérdida temporal y duración; aprobar reapertura, rotar credenciales, registrar incidente y acta.
Objetivos propuestos para piloto: RPO <=24 h con copia diaria y RTO <=8 h. No son garantías actuales.
Antes de venta, determinar si se requiere PITR/menor RPO y su coste; ensayo trimestral y tras cambio mayor.
Retención DB móvil 35 días, registros laborales en base activa según COMPLIANCE; no confundir ambos.

## H5 — journal independiente y ensayo sintético
Las migraciones H5 capturan bajas/cambios de estado y holds/liberaciones mediante triggers;
la purga offline escribe los UUID eliminados, counts, autorización y digest. No se archivan
nombres, fichajes, motivos libres, propuestas de corrección, PIN ni documentos laborales.
`journal_prepare` requiere el foreign server `fichaje_recovery` y falla cerrado si no está disponible.
La conexión técnica solo puede invocar el append de metadatos en la base externa.
Las migraciones no configuran ninguna conexión ni credencial de producción.

El archive confirma PREPARED antes del commit de la aplicación. `scripts/recovery_journal.py`
reconcilia la transacción original mediante `pg_xact_status` y el outbox inmutable: añade COMMITTED
o ABORTED, sin borrar ni editar entradas. Una subtransacción revertida no conserva outbox y se
clasifica ABORTED cuando la transacción principal termina. Esta reconciliación solo se ejecuta
contra la instancia original viva, nunca deduciendo resultados desde una base ya restaurada.
Si se pierde la instancia antes de resolver un PREPARED, la recuperación queda bloqueada para
reconciliación offline autorizada; no se presume commit ni rollback y no se reabre el servicio.

El archive necesita persistencia y custodia independientes del backup que se restaure. Restaurar
ambas bases al mismo punto invalidaría la garantía. Antes de reabrir: aislar Auth/REST, verificar
que el archive no tiene PREPARED sin resolver, reproducir sus eventos COMMITTED en orden,
comprobar bajas/holds/liberaciones/tombstones y RLS. El replay es transaccional e idempotente,
restringido al rol offline NOLOGIN; cada purga restaurada genera counts de lo realmente eliminado
en esa transacción, que pueden diferir del manifiesto original por el punto del backup.

CI aprovisiona exclusivamente una segunda base efímera en el contenedor local, con credencial
aleatoria que no se imprime. `tests/integration/h5.py` captura en memoria public/private mediante
pg_dump, ejecuta cambios posteriores, restaura realmente con pg_restore y reaplica el journal
que quedó fuera del dump. No se suben dumps ni journal como artefactos. `backup_database.sh`
sigue bloqueado; este ensayo no habilita backup ni restore de producción.

## H7 — backup cifrado y restore implementados; activación BLOCKED (2026-09-28)
- **Backup** (`scripts/backup_database.sh`): `pg_dump` 17 custom de datos (`public`, `private` salvo las tablas
  de contexto ligadas a la transacción, `auth.users`, `auth.identities`) en un único stream con `pipefail` hacia
  `age` (destinatario x25519); conexión `sslmode=verify-full` con CA explícita, servicio y `PGPASSFILE` 0600;
  fichero `.partial` → cabecera age comprobada → SHA-256 → copia al destino privado (0700 o rclone con config
  0600) → re-hash → manifiesto `fichaje.db-backup.v1` al final. Sale 2 (`BLOCKED`) si falta una condición: clave
  privada age presente en el entorno o en el destino, destino dentro del repositorio, contraseña en el service
  file, CA con clave privada, herramientas ausentes o espacio insuficiente. Un fallo de cifrado o de `pg_dump`
  invalida el backup y no deja texto plano (`tests/backup.test.ts`, 10 pruebas).
- **Restore** (`scripts/restore_database.sh`): verifica manifiesto y SHA-256 antes de descifrar; exige entorno
  vacío con las mismas migraciones y confirmación explícita del nombre de la base; descifra en stream hacia
  `pg_restore` y una sola transacción `psql` (`session_replication_role=replica`, comprobación de FK colgantes);
  COMMIT solo si todo terminó bien. No reabre nada: el journal se reaplica aparte y la reapertura es manual.
- **REC-01..03 ejecutados de verdad en local** (`tests/integration/rec.py`, CI `h7.yml`): TLS verify-full desde una
  CA de ensayo, login de backup de solo lectura, journal en una instancia PostgreSQL separada por dblink TLS,
  actividad sintética en dos empresas, backup, cambios posteriores (fichajes no journalizados = pérdida medida;
  bajas, revocaciones, holds y purga journalizados), destrucción del entorno fuente, repositorio restaurado
  desde bundle, restore en un Supabase vacío, replay idempotente del journal y validación (datos exactos, RLS y
  cross-tenant, Auth y sesiones antiguas, Storage, inmutabilidad, idempotencia, kiosco, exportaciones,
  invariantes y canary). Negativos: clave equivocada o ausente, ciphertext alterado o truncado → nada
  restaurado. PREPARED sin resolver con la instancia perdida → recuperación BLOCKED y alerta CRITICAL
  `RECOVERY_JOURNAL_BLOCKED`; nunca se deduce un commit perdido.
- **Medición REC-02 (local, sintética, dos ejecuciones del 2026-09-28)**: backup 2,1–2,3 s; pérdida medida
  3,4–3,5 s de fichajes posteriores al backup (1 fichaje, el esperado); RTO del ensayo 56,2–61,3 s (entorno +
  restore 41,1–46,2 s, replay 0,4 s, validación 12,1–12,4 s).
  No son compromisos: RPO ≤ 24 h y RTO ≤ 8 h siguen siendo objetivos propuestos, no garantías comerciales.
- **Monitor**: `backup_monitor.py --db-manifest … --db-restore …` solo informa OK si el restore de ensayo de ese
  mismo backup terminó bien; el checksum del ciphertext no basta.
- **BLOCKED para activar**: destino privado definitivo, custodia offline de la identidad age separada del
  destino, host de operación con conexión verify-full a staging, instancia independiente del journal con CA
  utilizable desde la base gestionada (`STAGING.md` §3.4) y ensayo en staging con un segundo proyecto vacío.
