# HITO 19 — sincronización controlada de staging (NO DESPLEGADO)

Revisión: 2026-10-14. **Estado operativo: BLOCKED**. Autorización del usuario:
sincronizar staging con `main` solo **después** de una copia recuperable y
restauración probada. Prohibido producción, nuevos costes y merge de este PR
sin una aprobación posterior. No se ha aplicado ninguna migración remota.

## 1. Evidencias observadas (solo lectura)

- Repositorio único `marioleongayo23-spec/fichaje`. H16 PR #33, H17 PR #34,
  H18 PR #35 fusionados a `main`. Último merge verificado H18:
  `75054aa98118ecae93eb056320924b166681d88e`.
- Destino autorizado **solo** `fichaje-staging` / proyecto Supabase
  `pvfjffeszsedslmwdvgh` (eu-west-1) y Cloudflare Pages
  `fichaje-staging.pages.dev`. Producción Supabase `bypdviatamosygndeqhh`
  está excluida; no reutilizar ningún secreto ni configuración.
- Consultas de solo lectura: staging ACTIVE_HEALTHY, 17 migraciones aplicadas,
  la última `20260930000200_export_generation.sql`. Aún no existen
  `create_employee_invitation` (H17) ni `decide_correction_with_policy` (H18).
- Release publicado en Pages en el último chequeo externo del 14/10:
  meta `fichaje-release=3d63c7775ff71e514dd5a29946f7b29018cc9f33`.
  Difiere del `main` anterior. HTTP 200 NO demuestra identidad del release
  ni conectividad de todas sus dependencias.

## 2. Las cinco migraciones pendientes, en este orden

1. `20261002000100_billing_readiness.sql`
2. `20261002000200_billing_checkout.sql`
3. `20261002000300_billing_sync_authorization.sql`
4. `20261014000100_employee_invitation_binding.sql` (H17)
5. `20261014000200_historical_correction_policy.sql` (H18)

Las tres de billing son contratos DB ya fusionados, NO conexión de Stripe
ni orden de activar cobros. Aplicarlas puede introducir nueva lógica/objetos;
requieren el mismo backup verificado. Si la base cambió desde este inventario,
volver a leer historial y revisar drift antes de actuar.

## 3. Preflight imprescindible antes de la primera escritura

**FAIL CLOSED** en cualquier ausencia, contradicción, riesgo de coste o secreto
no disponible. El operador debe custodiar las credenciales fuera de GitHub y
de ChatGPT; nunca pegarlas en PR, logs, chat o artefactos de CI.

1. Fijar SHA exacto de `main`, los 5 gates CI del mismo SHA, proyecto
   `pvfjffeszsedslmwdvgh`, Pages `fichaje-staging`. Verificar que todas las
   cuentas, tenants y objetos Storage son sintéticos; si no se demuestra,
   no ejecutar operaciones destructivas ni tests de escritura remotos.
2. Comprobar la conexión DB de staging con TLS `verify-full` y permisos mínimos.
   Verificar historial de migraciones completo desde Supabase (17 actuales),
   sin drift ni migraciones extra. No usar `supabase db reset` o `db pull`
   contra el remoto para sincronizarlo.
3. Ejecutar `scripts/backup_database.sh` con su `PGSERVICEFILE` y
   `PGPASSFILE` 0600, CA verificada, receptor público age y destino cifrado
   privado custodiado fuera del repo. Asegurar que incluye datos Auth y los
   esquemas esperados; inventariar Storage y ajustes de plataforma por separado.
4. **Descargar la misma copia cifrada desde el destino privado**, comprobar
   checksum y descifrar/restaurar con `scripts/restore_database.sh` en una
   base **vacía y realmente aislada** de staging y producción, misma versión
   y migraciones. Acreditar pruebas de Auth, RLS, FK, inmutabilidad, kiosco,
   recuperación del journal independiente, ausencia de PREPARED sin resolver,
   objetos Storage y configuración. La copia del código, un checksum y el
   ensayo efímero de GitHub Actions NO sustituyen esta comprobación.
5. Archivar **fuera del repo** el manifiesto cifrado y recibo de restore
   real, con fechas, hash, objetivo de restauración, aislamiento,
   recuperación del journal y firma del operador. Ni `list_migrations`
   ni las API actuales disponibles acreditan un restore independiente.
6. El chequeo sin escrituras `scripts/staging/h19_preflight.py` verifica
   destino, historial sin drift, frescura y coherencia de manifiesto y recibo.
   Esto es solo un **PRECHECK**, nunca una autorización automatizada para
   migrar o publicar. Un recibo JSON autodeclarado no prueba un restore:
   debe contrastarse con la operación real, journal y custodia.

Ejemplo (solo lectura, después de generar pruebas reales por el operador):
```bash
python3 scripts/staging/h19_preflight.py \
  --environment staging \
  --project-ref pvfjffeszsedslmwdvgh \
  --app-host fichaje-staging.pages.dev \
  --applied-versions /ruta/privada/applied-migrations.txt \
  --backup-manifest /ruta/privada/backup.manifest.json \
  --restore-receipt /ruta/privada/restore.result.json
```

## 4. Orden de operación remoto — solo cuando §3 tenga evidencia revisada

1. Bloquear o suspender escrituras sintéticas, guardar versión previa,
   inventario y plan de retorno. Nunca dar por reversible una migración:
   el rollback de frontend **no** revierte tablas/funciones.
2. Desde un clon limpio y con el SHA aprobado, usar CLI Supabase enlazado
   **únicamente** con `pvfjffeszsedslmwdvgh` y revisar el plan de
   `supabase db push` ANTES de confirmarlo. Comprobar el proyecto de
   destino justo antes de ejecutar. No usar `apply_migration` de MCP para
   fragmentar accidentalmente el plan de cinco scripts.
3. Verificar que las 22 migraciones y firmas/RPC esperadas constan en staging,
   sin drift. Si falla cualquiera, bloquear publicación de Pages y activar
   procedimiento de recuperación; no improvisar `down` migraciones.
4. Construir el frontend **desde ese SHA** con `FICHAJE_RELEASE` y
   `FICHAJE_COMMIT` exactos, ejecutar `npm ci && npm run check`,
   escanear secretos y publicar en **Cloudflare Pages staging** mediante
   `PlatformDeployer` con credenciales de operador y variables existentes.
   No apuntar a `Fichaje APP` ni activar Stripe/SMTP sin otro hito.
5. Verificar en HTTPS que `<meta name="fichaje-release">` coincide con
   el SHA publicado, CSS/JS se sirven íntegros, HTTPS/HSTS/CSP, sin CORS
   ni origen sin firmar, Auth/Storage/REST/RLS, cachés y gateway. Ejecutar
   `scripts/staging/verify_staging.py` **remoto** sin `--local`, más canary
   y E2E sintéticos de H16 (alta), H17 (invitación ligada), H18 (corrección
   histórica), kiosk, informes y exportaciones; comprobar auditoría e
   invariantes y actualizar evidencias. No almacenar códigos, PIN ni emails
   en el reporte.
6. Ejecutar salud, alerta, simulación de fallo/rollback, backups y canary
   posteriores; 0 FAIL, 0 SKIPPED en puertas obligatorias. Mantener este
   hito BLOCKED hasta demostrar las pruebas **remotas** y el estado final
   de los servicios, aunque GitHub Actions dé 5/5 local.

## 5. Reversión y límites

- Fallo antes de migración: no desplegar ni cambiar remoto. Fallo después:
  detener escrituras y preservar evidencia. NO restaurar datos sobre la base
  viva ni asumir que devolver el frontend anterior arregla un cambio SQL.
- Una recuperación DB exige aislamiento, replay de journal y validación de
  derechos históricos, bajas/holds/purgas, conforme `docs/RECOVERY.md`.
- Sin acceso de despliegue a Cloudflare Pages ni copia/restore externo
  verificable, no hay garantía suficiente para continuar. La política de
  coste 0 es vinculante: no crear proyectos Pro ni recursos facturables.

## 6. Resultado de H19 en esta sesión

**BLOCKED, por diseño**: no existe evidencia verificable de backup cifrado y
restore aislado de la versión actual de staging, ni credenciales de despliegue
Pages disponibles en las herramientas conectadas. Supabase MCP sí ofrece
lecturas y mutaciones SQL, pero ninguna demuestra una copia restaurable del
mismo backup y el journal externo. Todos los cambios remotos se han detenido.
Solo se han preparado controles, tests y documentación en rama/PR separados.
