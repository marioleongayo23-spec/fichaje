# CURRENT_STATE — 2026-10-01

## HITO 8 — GO-LIVE / producción en curso

**ESTADO ACTUAL: IN PROGRESS / NO PRODUCCIÓN REAL.**

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/hito-8-go-live`  
Base: `main@1b4d22488f028fb0d637cc74b15c230e8e920f6e`  
PR: #17 — OPEN; no merge sin aprobación expresa posterior.

### Candidato productivo auditado
Supabase `Fichaje APP`, ref `bypdviatamosygndeqhh`, `eu-west-1`, ACTIVE_HEALTHY.
Tiene las mismas 17 migraciones que staging, hasta
`20260930000200_export_generation.sql`.

Lectura inicial de 2026-10-01: 0 organizaciones, 0 memberships, 0 empleados,
0 fichajes, 0 usuarios Auth, 0 objetos Storage y 1 bucket técnico. No se borró ni
migró información porque no existe dato real en el candidato.

Las Edge Functions del candidato no constituyen todavía un release productivo porque falta
el borde Cloudflare y la identidad de release. Durante H8 se eliminó la deriva de código:
`kiosk` quedó ACTIVE v6 y coincide archivo a archivo con `main`; `export-link` ya coincidía
con `main`. No se abrió tráfico ni se introdujeron usuarios/datos.

### Cambios H8 ya iniciados
- Canary remoto: API y DB quedan fijadas independientemente por entorno; staging y
  production no pueden cruzarse; producción exige `FICHAJE_PRODUCTION_DB_HOST` y
  `sslmode=verify-full`. Se rechazan overrides efectivos por query URI, `hostaddr`,
  `service`, campos objetivo duplicados y puertos no estándar.
- Restore: una copia válida con cero organizaciones ya es aceptable; un fallo de
  descifrado/`pg_restore` propaga FAIL y ROLLBACK en vez de poder confundirse con éxito.
- Verificador de producción fail-closed: exige hosts production explícitos, HTTPS estándar
  y estado canary sintético owner-only antes de reutilizar las 33 comprobaciones externas H7.
  Las URLs directas de funciones no se pueden sobrescribir: se derivan de la API fijada.
- La puerta completa GO-01..GO-10 queda documentada en `docs/PRODUCTION.md`.

### Revisión externa
La revisión normativa preproducción se actualizó a 2026-10-01 en `docs/COMPLIANCE.md`.
No constituye certificación jurídica y mantiene las obligaciones por cliente.

### Revisión H8
La revisión automática del PR detectó y H8 corrigió antes de cierre tres fallos de guard:
doble barra en el meta-comando psql del restore, overrides de URLs directas del verificador y
override del host efectivo en DSN URI. Todos tienen regresión dedicada. Los checks válidos son
siempre los del HEAD final visible en PR #17; no se reutilizan resultados de commits anteriores.

### Evidencia productiva H8 — 2026-10-02
- GO-01 llegó a 5/5 workflows PASS sobre `3919f7a55bb49ac3adde85d78d5eebc8144cd05d`.
  El fix posterior del transporte del verificador mueve de nuevo el HEAD y obliga a repetir esos checks.
- Supabase y Cloudflare sirven `h8-3919f7a55bb4`; readiness remoto: kiosk Auth/DB UP y
  export-link Auth/REST/Storage/DB UP.
- PostgreSQL del kiosk usa login dedicado que solo hereda `fichaje_gateway`, pooler de sesión y
  `sslmode=verify-full` con CA oficial de Supabase; prueba real de TLS + SET ROLE PASS.
- GO-05: canary sintético productivo WEB + KIOSK PASS, sin rotación, incluyendo RLS,
  auditoría e idempotencia.
- Primer `verify_production.py`: 17 PASS / 16 FAIL / 0 SKIPPED. Los 16 fallos comparten
  transporte Cloudflare: el verificador usaba el User-Agent por defecto de urllib mientras las
  mismas rutas estaban UP con transporte de navegador. Se corrige únicamente el cliente de
  verificación/canary para modelar el tráfico same-origin real; GO-04 sigue pendiente hasta
  repetir el verificador y obtener PASS sin SKIPPED.

### Pendiente antes de PASS
- los cinco workflows obligatorios del HEAD final del PR deben terminar PASS;
- desplegar el release aprobado en Cloudflare + Supabase productivos y verificarlo remotamente;
- canary sintético productivo;
- ruta real de guardia + ticket;
- backup cifrado operativo + restore aislado de esa misma copia + journal;
- simulacro operativo de incidente;
- protección de `main`;
- checklist legal/comercial del primer cliente;
- aprobación expresa posterior del usuario para merge/activación.

No se han creado clientes, datos reales, nuevos proyectos de pago ni secretos en GitHub.
Cualquier gasto requiere autorización expresa.

## HITO 7 — cerrado
HITO 7 y todos los hitos anteriores permanecen aprobados e integrados en `main`.
La evidencia histórica sigue en Git y en la versión anterior de este archivo.
