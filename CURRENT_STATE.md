# CURRENT_STATE — 2026-10-01

## HITO 8 — GO-LIVE / producción en curso

**ESTADO ACTUAL: IN PROGRESS / NO PRODUCCIÓN REAL.**

Repositorio: `marioleongayo23-spec/fichaje`  
Rama: `astra/hito-8-go-live`  
Base: `main@1b4d22488f028fb0d637cc74b15c230e8e920f6e`  
PR: pendiente de abrir.

### Candidato productivo auditado
Supabase `Fichaje APP`, ref `bypdviatamosygndeqhh`, `eu-west-1`, ACTIVE_HEALTHY.
Tiene las mismas 17 migraciones que staging, hasta
`20260930000200_export_generation.sql`.

Lectura inicial de 2026-10-01: 0 organizaciones, 0 memberships, 0 empleados,
0 fichajes, 0 usuarios Auth, 0 objetos Storage y 1 bucket técnico. No se borró ni
migró información porque no existe dato real en el candidato.

Las Edge Functions del candidato existen pero son versiones anteriores a las desplegadas
en staging; no se consideran release productiva final.

### Cambios H8 ya iniciados
- Canary remoto: API y DB quedan fijadas independientemente por entorno; staging y
  production no pueden cruzarse; producción exige `FICHAJE_PRODUCTION_DB_HOST` y
  `sslmode=verify-full`.
- Restore: una copia válida con cero organizaciones ya es aceptable; un fallo de
  descifrado/`pg_restore` propaga FAIL y ROLLBACK en vez de poder confundirse con éxito.
- Verificador de producción fail-closed: exige hosts production explícitos y estado canary
  sintético owner-only antes de reutilizar las 33 comprobaciones externas H7.
- La puerta completa GO-01..GO-10 queda documentada en `docs/PRODUCTION.md`.

### Revisión externa
La revisión normativa preproducción se actualizó a 2026-10-01 en `docs/COMPLIANCE.md`.
No constituye certificación jurídica y mantiene las obligaciones por cliente.

### Pendiente antes de PASS
- completar tests/workflows del HEAD final del PR;
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
