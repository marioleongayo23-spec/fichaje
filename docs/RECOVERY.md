# Backup y recuperación
## Estado tras OPS-01
El repositorio genera un backup privado automáticamente cada día a las 01:30 UTC y también permite
ejecución manual. GitHub Actions conserva el artefacto 14 días. El workflow no conoce credenciales
de Google Drive ni ejecuta backup PostgreSQL. Una automatización externa de ChatGPT copia el último
artefacto válido al Drive privado del proyecto después de la ejecución nocturna.
`backup_database.sh` termina 2 incondicionalmente, incluso con variables; activarlo exige PR aprobado.

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
