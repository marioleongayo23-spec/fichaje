# Fichaje APP — instrucciones de ingeniería
Repositorio único: marioleongayo23-spec/fichaje. GitHub es la fuente técnica de verdad.
Astra implementa. Leer este archivo y CURRENT_STATE.md al iniciar cada sesión.

- Un hito autorizado por vez; rama propia y PR contra main. No hacer merge ni avanzar sin aprobación.
- Prioridad: correctitud, seguridad, cumplimiento, fiabilidad, simplicidad, coste, UX/UI.
- Stack fijo: React, TypeScript, Vite, PWA, Supabase Auth, PostgreSQL, RLS/RPC, Cloudflare Pages, GitHub Actions.
- No diseñar UI sin autorización expresa. No desplegar producción en H0.
- Roles OWNER/ADMIN/EMPLOYEE. organization_id + RLS en todos los datos de empresa.
- Tiempos del servidor, originales inmutables, correcciones append-only, auditoría transaccional.
- Toda mutación: autorización servidor, idempotencia y concurrencia controlada.
- V1 sin biometría, fotos, ubicación, nóminas, vacaciones ni HR general. Kiosco sin email.
- Nunca secretos, datos reales, dumps, PIN o tokens en git, logs, artefactos públicos o frontend.
- Cambios mínimos; tests obligatorios. No PASS con fallos o comprobaciones obligatorias pendientes.
- Actualizar CURRENT_STATE.md con alcance real, evidencias y limitaciones. Diseño documentado no equivale a implementación probada.
- Validación H0: npm ci && npm run check; bash -n scripts/*.sh; git diff --check.
- Documentación normativa: fuentes primarias, fecha de revisión, distinguir requisito legal de decisión técnica.

Formato de cierre: HITO / ESTADO (PASS, FAIL, BLOCKED) / RAMA / PR / TESTS / CAMBIOS / BLOQUEADORES / SIGUIENTE PASO.
