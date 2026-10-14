# STAGING real — procedimiento del operador (HITO 7)

## HITO 19 — auditoría y control de sincronización (2026-10-14)

**BLOCKED, sin operaciones remotas de escritura.** Esta sección es la evidencia de preflight realizada bajo autorización de HITO 19, no una certificación de despliegue.

### Objetivo y estado observado (solo lecturas)
- Repositorio GitHub `marioleongayo23-spec/fichaje`, `main` merge H18 `75054aa98118ecae93eb056320924b166681d88e`.
- Cloudflare Pages `https://fichaje-staging.pages.dev/`: responde y publica metadato `fichaje-release=3d63c7775ff71e514dd5a29946f7b29018cc9f33`. No coincide con el candidato de GitHub. Que la web responda HTTP 200 no prueba despliegue de H16-H18.
- Supabase **solo staging**, ref `pvfjffeszsedslmwdvgh`, región `eu-west-1`, estado `ACTIVE_HEALTHY`: **17 migraciones aplicadas, 5 pendientes**. El proyecto separado `Fichaje APP` no se ha consultado ni modificado mediante SQL.
- Pendientes exactas y en orden:
  1. `20261002000100_billing_readiness.sql`
  2. `20261002000200_billing_checkout.sql`
  3. `20261002000300_billing_sync_authorization.sql`
  4. `20261014000100_employee_invitation_binding.sql`
  5. `20261014000200_historical_correction_policy.sql`
- Drive (14/10/2026): localizada **terna completa** de copia cifrada del 02/10 (`.dump.age`, `.dump.age.sha256`, `.manifest.json`). Descarga de lectura y comprobación local del archivo cifrado: tamaño 30.980 B y SHA-256 **coinciden** con manifiesto y fichero checksum. Su manifiesto declara `restore_test=null`, última migración `20260930000200`, por lo que sigue sin constar restauración y no es un backup previo actual a la sincronización. No se ha usado clave privada ni descifrado información. El runtime actual no tiene `pg_dump`, `pg_restore`, `psql`, `age`, `supabase` ni `wrangler` ni credenciales de operador para Cloudflare, backup o Supabase.
- Se añade comprobación portátil con Python estándar de integridad de una copia nueva: `python3 scripts/staging/h19_backup_artifact.py --directory /ruta/privada --backup-name fichaje-db-AAAAMMDDTHHMMSSZ-xxxxxxxx --expected-migration 20260930000200`. **Debe ejecutarse donde el operador custodie las copias, nunca cargando archivos al repositorio.** Rechaza backups antiguos (>24 horas por defecto), incompletos, no `age`, con SHA alterado o migración distinta. Salida `artifact_integrity=PASS` acredita **solo** el fichero cifrado; `restore=NOT_TESTED`, `provenance=UNVERIFIED` y `ready_for_migration=false` permanecen deliberadamente bloqueados hasta completar el ensayo real, journal e invariantes. No pasar de GATE B basándose solo en este comando.
- Supabase Free no ofrece backups automáticos gestionados; los dumps cifrados y la custodia son responsabilidad del operador. Fuentes: https://supabase.com/docs/guides/platform/backups y `docs/RECOVERY.md`. No se autoriza contratación ni creación de un tercer proyecto Supabase.

### Puertas obligatorias secuenciales (ninguna puede omitirse)
**GATE A — custodio / origen.** Desde un equipo de operación confiable y autorizado, comprobar que la URL, proyecto y ref son *exactamente* staging y que los datos son exclusivamente sintéticos. Verificar origen `main` y HEAD 5/5 PASS; comparar migraciones instaladas con las cinco pendientes; capturar identificador de release previo como candidato de rollback. Comprobar permisos, clientes y conexión TLS `verify-full`, sin exportar secretos a GitHub ni al navegador. Ausencia de cualquier requisito = **STOP**.

**GATE B — copia y restore probados antes de migrar.** Usar `scripts/backup_database.sh` con los secretos SOLO desde custodia privada en equipo confiable, PostgreSQL cliente compatible, destinatario `age` público, destino privado fuera del repositorio, CA/PGSERVICEFILE/PGPASSFILE con permisos correctos. Verificar que se generen el fichero `.dump.age`, manifest y checksum, y sus hashes. En **PostgreSQL local aislado y vacío** con el esquema exacto anterior a la migración, usar `scripts/restore_database.sh`, recuperar journal según `docs/RECOVERY.md` y ejecutar verificaciones de Auth, relaciones tenant, estados, secuencias, referencias e invariantes. Verificar `scripts/ops/backup_monitor.py` y su comprobante de restore. Los objetos binarios de Supabase Storage y configuraciones/credenciales fuera de la base requieren protección independiente; la mera copia de metadatos no basta. No hace falta contratar una tercera base remota: el ensayo local aislado sirve **solo si todas las pruebas reales de recuperación pasan**. Guardar artefactos y claves privados y separados; **al PR únicamente resultados PASS/FAIL sin datos sensibles**. Si no hay archivo, claves, restore aislado o evidencia completa, **STOP sin ejecutar `supabase db push`**.

**GATE C — migraciones solo en staging.** Tras GATE B PASS, inspeccionar `supabase migration list` y plan de `supabase db push --dry-run`, sin drift. Aplicar exclusivamente las cinco migraciones mencionadas en su orden mediante el procedimiento oficial desde el checkout exacto. Validar 22/22 migraciones, RPC/RLS/roles/permiso/grants; verificar `create_employee_invitation` y `decide_correction_with_policy` en la **base staging**. Cualquier divergencia, estado parcial o secreto no disponible: STOP, documentar y activar runbook; **nunca reparar mediante reset remoto** ni modificar `Fichaje APP`.

**GATE D — frontend y funciones de staging.** En operador autenticado con credenciales de Cloudflare y Supabase Edge conservadas fuera de GitHub, construir release inmutable del commit anterior y desplegar **exclusivamente** `fichaje-staging` con el `PlatformDeployer` de `scripts/ops/deployers.py`. Antes de mover release confirmar compatibilidad con el esquema ya migrado, disponibilidad de release sano anterior y rollback del código (el rollback NO deshace migraciones). No configurar Stripe real ni producción. Comprobar el metadato `fichaje-release` y checksum del manifest publicados, sin aceptar solo un HTTP 200.

**GATE E — validación remota sintética.** Ejecutar `scripts/staging/verify_staging.py` en modo **remoto** (no `--local`), canary, health, alertas, pruebas Auth/RLS y dos empresas sintéticas: alta con política (H16), invitación aceptada y vinculada sin duplicado (H17), jornada anterior y revisión independiente con evidencia append-only (H18); fichaje, kiosco y exportación; todas las rutas de seguridad y 5 gates 5/5 PASS del release correspondiente. Si falta alguna capacidad o prueba, **BLOCKED**; documentar resultado y no declarar comercializable ni pasar a producción.

### Estado y límites
El HITO 19 llegó a lectura/diagnóstico, verificación de integridad de la copia antigua y creación de un comprobador offline de solo lectura, además del plan controlado. **GATE B no ejecutado ni PASS; por dependencia GATE C/D/E no ejecutados**. Ninguna migración o publicación remota realizada. PR propio y rama independiente; no hacer merge sin una orden posterior expresa del usuario. No usar SQL Editor de staging para simular un backup/restauración ni subir dumps, JWT, PIN o secretos al repositorio.

---

## Estado remoto más reciente — 2026-09-29 (PR #15)

`verify_staging.py` se ejecutó contra Pages y Supabase reales, sin `--local`,
con estado canary `0600`: **33 PASS, 0 FAIL, 0 SKIPPED**. Web y kiosco
sintéticos completaron sus ciclos. SEC-H4-01 observó un único bucket de
cuatro fallos PIN desde dos orígenes de red, de modo que Edge ve el peer
del proxy de Cloudflare. El probe temporal y su secreto se retiraron.
Invariantes: 0 CRITICAL, 0 WARNING y un INFO de la sesión de control.

**HITO 7 sigue BLOCKED:** el monitor del host de ejecución no está operativo
sin su DSN y con la latencia del proxy; faltan alertas, fallo inducido y
rollback, carga, incidente y backup/REC-01..03 remotos. La autorización
posterior permitió un segundo proyecto temporal exclusivamente para restore,
previa confirmación del coste. El usuario confirmó el coste consultado de
0/mes, pero Supabase rechazó la creación por el límite global de dos
proyectos Free activos del propietario. No se creó otro ni se tocó el
proyecto `Fichaje APP`. Una organización Pro temporal separada requeriría
nueva autorización de facturación a su tarifa real. Las notas históricas
inferiores describen estados anteriores y no prevalecen sobre esta sección.


Revisado el 2026-09-29. **Staging remoto parcial: BLOCKED — no READY FOR PILOT.**
Se reutiliza exclusivamente Supabase `fichaje-staging`
(`pvfjffeszsedslmwdvgh`, `eu-west-1`), con 15 migraciones, RLS,
Auth sin registro público, bucket privado y Edge Functions `kiosk` y
`export-link` activas. Cloudflare Pages `fichaje-staging` sirve el
frontend y `/gateway/*` con secreto de ingreso emparejado, CSP, HSTS,
`no-store`, `noindex` y sin CORS abierto observado.

Se creó el login de PostgreSQL `fichaje_gateway_login` únicamente en
ese proyecto, sin privilegios administrativos ni BYPASSRLS y con la sola
membresía `fichaje_gateway`. `KIOSK_DATABASE_URL` está en Edge Secrets
con pooler de sesión y TLS `verify-full`. El `kiosk` directo sin firma
respondió 403 y su liveness por gateway 200. Una petición remota a
`/gateway/kiosk/health/ready` con la función `kiosk` normal desplegada
respondió **200 `UP`**, con `database=UP` (log Edge de las 07:10:27 UTC).
La lectura se hizo desde un probe temporal en `export-link` sin ciclo
de llamadas; se retiró y se redeplegó `export-link` original. Los cinco
workflows del head `8c12ccd` acabaron success. Quedan pendientes
`verify_staging.py` sin `--local` y las otras puertas de §4; la CI
local no da PASS al staging remoto.

El acceso del Cloud Browser al `*.pages.dev` está bloqueado por el
cliente y el egress de la shell hacia esa URL devuelve 403, de modo que
el verificador remoto aún no se ejecutó. La revisión automática impidió
un diagnóstico temporal de autofetch `kiosk → gateway → kiosk` por
riesgo de llamadas recursivas; no se ejecutó. El restore en segundo
proyecto que prescribe §4 tampoco se ha efectuado: la instrucción
expresa es no crear otro Supabase. Se requiere definir una alternativa
aislada dentro del proyecto existente antes de afirmar REC-01..03.
No hay datos laborales reales, producción, DNS definitivo ni merge.

## 1. Topología
```
navegador / kiosco ──HTTPS──▶ Cloudflare Pages  (proyecto de staging, Direct Upload)
                               ├─ estáticos: dist/ + _headers (CSP, HSTS, sin CORS, noindex) + _routes.json
                               └─ Pages Function /gateway/*  (edge/gateway.ts)
                                    │  firma x-fichaje-edge (HMAC, 60 s, método+función+ruta+cuerpo)
                                    ▼
                   Supabase (proyecto de staging, región UE)
                     Edge Functions: kiosk, export-link (verify_jwt=false; validan JWT con Auth y exigen la firma)
                     Auth · PostgREST · Storage (bucket privado fichaje-evidence) · PostgreSQL 17
                                    │ dblink TLS verify-full
                                    ▼
                   Instancia PostgreSQL independiente del journal de recuperación (UE)
host de operación (custodia del operador): health, canary, invariantes, alertas, backup cifrado, restore
```
- **Aislamiento staging/producción**: proyectos, cuentas o al menos proyectos separados en Cloudflare y Supabase;
  claves, pepper, secretos de red e ingreso, logins técnicos, destino de backup, clave age y journal **distintos
  por entorno**. Staging nunca reutiliza la base de producción ni sus secretos, y solo contiene datos sintéticos.
- **Por qué `verify_jwt=false`**: los health checks no llevan JWT y las funciones ya validan cada JWT contra Auth
  (`/auth/v1/user`, que además detecta sesiones revocadas). Sin la firma del borde, las funciones responden 403
  antes de interpretar el cuerpo (solo leen sus bytes acotados, 8 KiB/1 KiB, para comprobar la huella firmada),
  validar JWT o tocar SQL (probado: `tests/integration/h7_edge.py`).

## 2. Secretos: dónde viven (nunca en Git, GitHub, `VITE_*`, artefactos ni logs)
| Secreto | Store | Rotación |
|---|---|---|
| `KIOSK_PEPPER` (≥32 bytes) | Supabase Edge Functions secrets | Rotarlo invalida todos los PIN: solo con reseteo planificado de PIN |
| `KIOSK_NETWORK_SECRET` (≥32 bytes, ≠ pepper) | Supabase secrets | Rotarlo reinicia los buckets de red (controlado) |
| `FICHAJE_INGRESS_SECRET` (+ `_PREVIOUS` durante la rotación) | Supabase secrets **y** Cloudflare Pages (variable cifrada) | Sin corte: RUNBOOKS `#edge-ingress`; ensayado en `h7_incident.py` |
| `KIOSK_AUTH_PROVISION_KEY` (clave secreta/service de Auth) | Supabase secrets | Según política del proveedor; tras incidente |
| `KIOSK_DATABASE_URL` (login que solo hereda `fichaje_gateway`) | Supabase secrets | 90 días o tras incidente |
| `KIOSK_AUTH_URL`, `KIOSK_ANON_KEY`, `FICHAJE_ENV=staging` | Supabase secrets (no secretos, pero server-side) | — |
| `FICHAJE_KIOSK_UPSTREAM`, `FICHAJE_EXPORT_LINK_UPSTREAM` | Variables de Cloudflare Pages (no secretas) | — |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (formato `sb_publishable_…`) | Variables de build de Pages (públicas) | — |
| `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN` (solo Pages Edit de la cuenta), `CLOUDFLARE_ACCOUNT_ID` | Custodia del operador (gestor de contraseñas), variables de entorno del proceso | 90 días |
| Contraseñas de logins OPS, backup, restore y del archive del journal | Custodia del operador (`PGPASSFILE` 0600 temporal) | 90 días |
| Identidad age (clave privada de backup) | Custodia offline separada del destino del backup | Anual; conservar la anterior mientras existan backups suyos (35 días) |
| `OPS_PAGERDUTY_ROUTING_KEY`, `OPS_GITHUB_TOKEN` (fine-grained, Issues R/W de un repo privado) | Custodia del operador en el host de operación | Anual o tras incidente |

GitHub Actions **no** recibe ningún secreto persistente: la CI sigue trabajando solo con entornos efímeros.

## 3. Alta del entorno (una vez)
1. **Supabase**: crear el proyecto de staging en una región UE (`[[REGIÓN]]`, no se puede cambiar después).
   Auth: registro público desactivado, confirmación de email activada, `site_url` y URLs de redirección = URL de
   staging, límites de Auth explícitos, SMTP `[[DECISIÓN]]`. Anotar la CA de la base (Database → SSL).
2. **Migraciones desde cero**: `supabase link --project-ref <ref>` y `supabase db push`; comprobar
   `supabase migration list` = las 15 migraciones del repositorio y ningún drift.
3. **Logins técnicos** (psql como propietario, con `\password` para no dejar contraseñas en el historial):
   login de gateway con `grant fichaje_gateway`; logins OPS con `fichaje_ops_monitor`, `fichaje_ops_reviewer`,
   `fichaje_ops_repairer`; login de backup `LOGIN BYPASSRLS CONNECTION LIMIT 2` con `pg_read_all_data` y
   `default_transaction_read_only=on`. Ninguno con otros privilegios.
4. **Journal independiente**: instancia PostgreSQL separada (proveedor/cuenta `[[…]]`) con el esquema de
   `scripts/recovery_archive.py`, roles `fichaje_archive_connection` (LOGIN, solo `journal.prepare/verify`) y
   `fichaje_archive_writer`, TLS obligatorio para ese rol en `pg_hba`. En la base de staging: servidor
   `fichaje_recovery` (`dblink_fdw`) con `sslmode 'verify-full'` y la CA accesible por el servidor (con Supabase
   gestionado solo `sslrootcert=system` es utilizable: el journal necesita un certificado de CA pública, o
   documentar la limitación antes del piloto) y *user mapping* para `fichaje_journal`.
5. **Funciones**: `supabase secrets set --env-file <(gestor de secretos)` con la tabla del punto 2 y despliegue
   mediante `scripts/ops/deployers.py` (`PlatformDeployer`, `--no-verify-jwt --use-api`; `supabase/config.toml`
   declara también `verify_jwt = false` para ambas funciones).
6. **Cloudflare Pages**: proyecto Direct Upload `[[fichaje-staging]]`, variables/secretos del punto 2,
   `NODE_VERSION=24`; despliegue con `PlatformDeployer` (wrangler desde la copia de la release). Dominio: el
   `*.pages.dev` del proyecto; un subdominio propio (necesario para reglas WAF de zona) requiere autorización de
   DNS `[[DECISIÓN]]`.
7. **Límites de borde (WAF)** en la zona del subdominio, por IP (los cuenta Cloudflare, el código no lee
   cabeceras de IP): `/gateway/*` 60 peticiones/10 s; `/gateway/kiosk/authenticate` 20/10 s. Sin reglas que
   reintenten, reescriban o cacheen peticiones (la idempotencia es del servidor).
8. **Host de operación** (custodia del operador): cron de `health.py` (1 min), `canary.py run` (5 min),
   `invariants.py record` (1 h), `backup_database.sh` (diario) + `restore_database.sh` de ensayo (semanal) +
   `backup_monitor.py --db-manifest --db-restore`, y `alerts.py --environment staging` con
   `OPS_ALERT_ROUTE_PAGER=pagerduty` y `OPS_ALERT_ROUTE_TICKET=github-issues:<owner>/<repo>`.

## 4. Verificación del staging (todas deben dar PASS)
| Comprobación | Comando / evidencia |
|---|---|
| TLS, HSTS, CSP, cabeceras, caché, sin source maps, sin secretos en el bundle, contrato del borde, sin bypass directo, Auth, Storage privado, API anónima denegada, esquema privado oculto | `SUPABASE_ANON_KEY=… python3 scripts/staging/verify_staging.py --app-url https://<staging> --api-url https://<ref>.supabase.co --canary-state <estado 0600>` |
| Peer TCP real del gateway (SEC-H4-01) | 3 fallos de PIN desde la red A y 1 desde la red B contra un tenant sintético; como propietario: `select count(*), max(failures) from private.kiosk_network_buckets where organization_id='<tenant sintético>'` (solo recuentos). 1 bucket ⇒ peer = proxy (comportamiento conservador: 60 fallos/15 min bloquean el kiosco de todo el tenant); 2 ⇒ el runtime ve la red de origen. Si `info.remoteAddr` no fuera fiable, el gateway ya falla cerrado (403) |
| Canary web + kiosco a través del borde | `FICHAJE_ENV=staging FICHAJE_STAGING_API_HOST=<ref>.supabase.co` + `canary.py provision` (DSN del propietario con `sslmode=verify-full`) y `canary.py run` |
| Health y alertas reales | `health.py` → `alerts.py` con las rutas reales; fallo inducido: release con `faults.break_release(..., 'edge-signature-broken')` promovida con `release_gate.promote()` y `PlatformDeployer` ⇒ página y ticket, rollback, RESOLVED |
| Carga del piloto | `scripts/ops/loadtest.py` con tenants sintéticos de staging (misma forma que `tests/integration/h7_load.py`) |
| Backup cifrado + restore | `backup_database.sh` contra staging y `restore_database.sh` en un **segundo proyecto vacío** con las mismas migraciones, journal reaplicado y validación de REC-01 |
| Incidente | Mismo guion que `tests/integration/h7_incident.py`, con tiempos reales anotados |

El verificador se ejecuta de verdad en cada CI contra la forma de staging en local (`h7_edge.py`, modo `--local`
con las URL directas de las funciones): 30 comprobaciones PASS y solo las 3 de TLS omitidas por ser loopback.
Registrar cada ejecución (fecha, commit, resultado, tiempos) en `CURRENT_STATE.md`. Un solo FAIL o SKIPPED
mantiene H7 BLOCKED.

## 5. Límites conocidos que staging debe confirmar
- Peer TCP de `Deno.serve` en Supabase Edge Runtime (SEC-H4-01): desconocido hasta medirlo.
- Latencia del kiosco: Argon2id (19 MiB, t=2) cuesta ~100–200 ms de CPU por verificación y se serializa en cada
  instancia del gateway. En local (`h7_load.py`): pico de piloto con 8 kioscos ocupados y cadencia humana
  (3 s código + PIN, 1 s para elegir) p95 607 ms identificación y ≤ 399 ms registro con 4 CPU (744/523 ms con
  2 CPU); los mismos kioscos sin pausas (saturación) 0,82–1,22 s según CPU y ejecución (una ejecución dio
  1053,7 ms en el registro), y 20 autenticaciones simultáneas 1,8–2,9 s. El modelo de concurrencia de Supabase
  decide la cifra real.
- `SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` inyectadas en Edge Functions: confirmar compatibilidad con las
  claves nuevas del proyecto.
- Journal por dblink con TLS verify-full desde la base gestionada (ver 3.4).
- Floods HTTP directos contra `*.supabase.co` (PostgREST/Auth): no se pueden poner detrás del borde propio; los
  absorbe la plataforma. Medido en local: 504–574 llamadas inválidas de telemetría (310–435/s) rechazadas sin
  escribir y sin errores en los fichajes concurrentes.
