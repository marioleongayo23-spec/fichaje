# CURRENT_STATE — 2026-10-01

## GO-LIVE / PRODUCCIÓN — en curso

**ESTADO ACTUAL: BLOCKED.** HITO 7 permanece aprobado e integrado. El usuario autorizó iniciar la puerta GO-LIVE el 2026-10-01, pero no existe todavía autorización para mergear esta rama ni para activar datos reales.

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/go-live-produccion`  
PR: pendiente de apertura

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
Ambos proyectos muestran 20 warnings por RPC `SECURITY DEFINER` ejecutables por `authenticated`. Son funciones deliberadamente expuestas como RPC de servidor y **no se consideran cerradas por el mero warning**: su aceptación depende de los GRANT, comprobaciones actor/tenant, RLS y suites ya existentes.

Staging mostró además `auth_leaked_password_protection` desactivado; el candidato productivo no mostró ese warning en la revisión realizada.

### Cambio GO-LIVE implementado
Se añadió binding explícito de entorno:
- `staging` solo puede usar `https://pvfjffeszsedslmwdvgh.supabase.co`;
- `production` solo puede usar `https://bypdviatamosygndeqhh.supabase.co`;
- producción exige gateways same-origin relativos.

Hay tests unitarios para impedir cruce staging/prod y endpoints externos en producción.

### Revisión legal 2026-10-01
Se verificó con fuentes primarias que el Proyecto de Ley 121/000058 sobre reducción de jornada y garantía del registro digital fue rechazado/devuelto por el Congreso el 10-09-2025. No se trata como obligación vigente.

Se mantiene como base general el art. 34.9 ET y la orientación AEPD sobre base legal/deber de información. El convenio aplicable de cada cliente sigue siendo una comprobación previa al alta.

### Gates pendientes
Definidos en `docs/GO_LIVE.md`. Bloqueos reales actuales:
- ruta de alerta real probada;
- backup DB real cifrado y restore remoto;
- journal independiente operativo;
- simulacro operativo final;
- kit legal/contractual final para cliente real;
- branch protection/ruleset de `main`;
- despliegue Cloudflare productivo separado y verificado;
- autorización expresa posterior de producción.

Supabase Free no aporta backups automáticos gestionados; su documentación recomienda dumps/exportaciones off-site para Free. No se contratará Pro/PITR ni otro servicio sin autorización expresa.

### Coste y datos
- 0 clientes reales.
- 0 datos laborales reales en producción.
- 0 gasto nuevo autorizado.
- No se han añadido secretos a GitHub.
- No se ha activado producción.

No declarar PASS hasta que todos los GL-01..12 estén acreditados.
