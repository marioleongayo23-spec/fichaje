# STAGING real — procedimiento del operador (HITO 7)

Revisado el 2026-09-29. **Estado: staging remoto parcial; BLOCKED — no READY FOR PILOT.**
Supabase `fichaje-staging` en `eu-west-1` conserva las 15 migraciones, Auth
sin registro público y las dos Edge Functions. Cloudflare Pages
`fichaje-staging` sirve el frontend y la Pages Function original de
`functions/gateway/[[path]].ts` desplegada con Wrangler desde el bundle del
commit `37aa36c`. Las variables VITE públicas, ambos upstreams y el secreto
`FICHAJE_INGRESS_SECRET` como `secret_text` constan en Pages. El origen
estable responde 200 en portada y 404 JSON para `/gateway/invalid`;
HSTS, CSP y `noindex` están presentes, sin CORS abierto observado. La
ruta `/gateway/kiosk/health/live` transmite un 500 `WORKER_ERROR` de
Supabase porque allí faltan secretos server-side. Supabase ya tiene
`FICHAJE_ENV=staging` y `KIOSK_AUTH_URL`, pero no las otras credenciales
obligatorias. El 403 directo sin firma y las pruebas remotas siguen pendientes.

La CLI de Supabase no está autorizada de forma verificable: la revisión
automática detuvo el intercambio del código de login por un token persistente
al requerir aprobación específica para ese alcance. No reintentar por una
vía indirecta. Tras una autorización expresa, completar el store de secrets,
verificar el 403 y ejecutar todos los gates de la sección 4. La restricción
expresa de esta sesión es **no crear otro proyecto Supabase**; el ensayo de
restore en un segundo proyecto de §4 permanece bloqueado hasta acordar una
alternativa aislada dentro del staging existente. Nada de esto habilita
producción, datos laborales reales, DNS definitivo ni merge.

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
