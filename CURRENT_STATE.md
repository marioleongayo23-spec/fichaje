# CURRENT_STATE — 2026-10-01

## GO-LIVE / PRODUCCIÓN — en curso

**ESTADO ACTUAL: BLOCKED.** HITO 7 permanece aprobado e integrado. El usuario autorizó iniciar la puerta GO-LIVE el 2026-10-01, pero no existe todavía autorización para mergear esta rama ni para activar datos reales.

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/go-live-produccion`  
PR: #18 — OPEN

### Base heredada
HITO 0, OPS-01, HITO 1, HITO 2, HITO 3, HITO 4, HITO 5, HITO 6, OPS-02 y HITO 7 están aprobados e integrados en `main`.

### Candidato productivo verificado
Supabase `Fichaje APP`, ref `bypdviatamosygndeqhh`, región `eu-west-1`, observado `ACTIVE_HEALTHY`.

Lectura de solo estado el 2026-10-01:
- última migración: `20260930000200`;
- organizaciones: 0;
- memberships: 0;
- empleados: 0;
- fichajes: 0;
- buckets Storage: 1.

Staging `pvfjffeszsedslmwdvgh` tiene la misma migración. No se han introducido clientes ni datos reales.

### Security Advisor
Revisión remota del 2026-10-01: producción muestra exactamente 20 WARN `authenticated_security_definer_function_executable`, correspondientes al catálogo intencional de RPC autenticadas y cubiertos por GRANT/guards/RLS/suites H1–H7. No hay hallazgo CRITICAL ni warning adicional en el candidato productivo. **GL-02 PASS**.

Staging muestra los mismos 20 WARN y además `auth_leaked_password_protection` desactivado; ese hardening de staging no se confunde con el estado del candidato productivo.

### Cambio GO-LIVE implementado
Se añadió binding explícito de entorno:
- `staging` solo puede usar `https://pvfjffeszsedslmwdvgh.supabase.co`;
- `production` solo puede usar `https://bypdviatamosygndeqhh.supabase.co`;
- producción exige gateways same-origin relativos.

Hay tests unitarios para impedir cruce staging/prod y endpoints externos en producción.

### Revisión legal 2026-10-01
Se verificó con fuentes primarias que el Proyecto de Ley 121/000058 fue sometido a devolución el 10-09-2025 y figura concluido/rechazado desde el 11-09-2025. No se trata como obligación vigente.

También se incorporó el Real Decreto 723/2026, publicado el 15-09-2026 y con entrada en vigor el 05-10-2026. Fichaje V1 queda expresamente fuera de la toma automatizada de decisiones laborales: registra hechos y ejecuta reglas deterministas, sin decidir jornada, turnos, salario, productividad, sanciones ni extinción.

Se mantiene como base general el art. 34.9 ET y la orientación AEPD sobre base legal/deber de información. El convenio aplicable de cada cliente sigue siendo una comprobación previa al alta.

### Gates pendientes
Definidos en `docs/GO_LIVE.md`. Bloqueos reales actuales:
- ruta de alerta real: **PASS** (run `36881276163`; CRITICAL #22 y WARNING #23 abiertos/cerrados por el adaptador real);
- backup DB real cifrado y restore: **PARTIAL**; destino privado candidato creado y helpers seguros listos; falta ejecutar el bootstrap/drill local con credenciales introducidas de forma oculta;
- journal independiente operativo: **BLOCKED**; el bootstrap seguro está listo. Tras expirar el intento por navegador se verificó directamente que no quedó ningún rol/esquema journal en staging ni foreign server/user mapping en producción;
- simulacro operativo final;
- kit legal/contractual final para cliente real: proveedores principales, región y transferencias revisados a 2026-10-01; pendiente completar entidad jurídica de Fichaje, SMTP/destino backup definitivo y datos/convenio del primer cliente;
- control de procedencia de release: **PASS de contrato/CI** en `production-candidate.yml`;
- despliegue Cloudflare productivo separado y verificado;
- autorización expresa posterior de producción.

Supabase Free no aporta backups automáticos gestionados; su documentación recomienda dumps/exportaciones off-site para Free. No se contratará Pro/PITR ni otro servicio sin autorización expresa.

Los scripts de backup/restore DB quedaron portables entre Linux y macOS y aceptan el trust store del sistema para Supabase manteniendo TLS `verify-full`, permisos 0600/0700, cifrado age en stream y separación de la clave privada. El login de backup GO-LIVE quedó además reducido a lectura explícita de `public`, `private` y `auth.users`/`auth.identities`; se revoca `pg_read_all_data`. El bootstrap guarda la identidad privada `age` en macOS Keychain y elimina sus copias temporales antes de iniciar `pg_dump`; el backup opera únicamente con el destinatario público.

Se añadieron `scripts/go_live_recovery_bootstrap.sh` y `scripts/go_live_restore_drill.sh`: contraseñas introducidas ocultas localmente, credenciales técnicas generadas fuera de GitHub, identidad age en macOS Keychain, journal producción→staging separado, logins de backup read-only, backup remoto sintético cifrado y restore exacto en Supabase local desechable. Falta su ejecución real; el código no sustituye esa evidencia.

Revisión de proveedores: Supabase productivo `eu-west-1` corresponde a Irlanda según documentación vigente; DPA y lista de subencargados revisados. Cloudflare dispone de DPA/SCC, pero Pages/Workers procesa globalmente por defecto salvo controles adicionales de Data Localization Suite. La documentación comercial ya no promete residencia UE total en el borde.

### Coste y datos
- 0 clientes reales.
- 0 datos laborales reales en producción.
- 0 gasto nuevo autorizado.
- No se han añadido secretos a GitHub.
- No se ha activado producción.

GitHub Free no permite protected branches/rulesets en repositorios privados. Se implementó un control compensatorio gratuito: el workflow manual `Production Candidate` rechaza cualquier SHA que no sea el HEAD actual de `main`, merge commit de un PR y 5/5 gates verdes, y solo entonces empaqueta el build productivo fijado al Supabase `bypdviatamosygndeqhh`.

GL-05 quedó probado de extremo a extremo con GitHub Issues privado y token efímero de Actions. La prueba real detectó y corrigió dos defectos del adaptador (formato opaco del token y cierre inmediato tras creación); el run `36881276163` terminó `success` y dejó #22/#23 cerrados como evidencia.

Cloudflare: el acceso por navegador conectado llegó a la pantalla de login; no se inspeccionó ni modificó la cuenta. GL-11 sigue BLOCKED hasta disponer de sesión autenticada.

No declarar PASS hasta que todos los GL-01..12 estén acreditados.
