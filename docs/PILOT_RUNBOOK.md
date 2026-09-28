# Runbook del piloto comercial (HITO 7)

Revisado el 2026-09-28. **No se ha ejecutado con ninguna empresa real.** Cada paso se ha ensayado solo con datos
sintéticos (suites citadas en cada apartado). Este runbook no autoriza por sí mismo nada de lo siguiente, que
requiere aprobación expresa y posterior: abrir producción, dar de alta una empresa piloto, introducir datos
laborales reales, cambiar DNS público definitivo o comprometer SLA/RPO/RTO.

Documentos relacionados: [`STAGING.md`](STAGING.md) (entorno), [`RUNBOOKS.md`](RUNBOOKS.md) (alertas),
[`RECOVERY.md`](RECOVERY.md) (backup y restore), [`legal/`](legal/README.md) (plantillas) y
[checklist de alta y baja](legal/CHECKLIST_ONBOARDING_OFFBOARDING.md).

## 0. Puerta previa (todas obligatorias)
- [ ] Staging real verificado con `scripts/staging/verify_staging.py` (PASS sin SKIPPED) y peer TCP medido.
- [ ] Alertas reales: página (CRITICAL) y ticket (WARNING) recibidas y resueltas en staging.
- [ ] Backup cifrado diario activo con restore de ensayo verificado (REC-01..03) y journal independiente.
- [ ] Revisión independiente de seguridad y de la documentación legal con fuentes primarias.
- [ ] Contrato, encargo de tratamiento y checklist de convenio/pausas firmados por la empresa piloto.
- [ ] Aprobación expresa de producción y de la empresa piloto concreta.

Reglas que nunca cambian durante el piloto: horas siempre del servidor; los originales no se editan; toda
corrección es una solicitud aprobada por otro gestor (append-only); ninguna persona del proveedor modifica
fichajes; nada de PIN, contraseñas, tokens, emails o datos laborales en tickets, chats, logs o capturas.

## 1. Alta de la organización y del OWNER
1. La empresa designa a su OWNER (persona responsable) y facilita su email corporativo por canal seguro.
2. Operador: crea la identidad en Supabase Auth (Dashboard → Authentication → Add user, con confirmación de
   email; el registro público está desactivado) y espera a que el OWNER confirme el email.
3. Operador, como propietario de PostgreSQL y con el UUID de organización generado en el momento:
   `select private.bootstrap_organization('<org uuid>', '<nombre de la empresa>', '<auth uuid verificado>', '<request uuid>');`
   Es idempotente y auditada; no existe ninguna vía cliente para crear empresas.
4. El OWNER entra en la app, comprueba su empresa y queda registrado en la auditoría.
- Ensayado: `tests/integration/h1.py`, canary (`scripts/ops/canary.py provision`).

## 2. Gestores (ADMIN) y personas con cuenta
1. OWNER → *Gestión → Personas*: invitación con rol (ADMIN o EMPLOYEE). La app genera un token aleatorio y solo
   guarda su SHA-256; el enlace se entrega **fuera de banda** (no hay envío de email). Caduca en 24 h, un uso.
2. La persona inicia sesión con su email verificado y acepta la invitación.
3. Nombrar **al menos dos gestores** (OWNER + ADMIN o dos ADMIN): quien solicita una corrección o es la persona
   afectada no puede decidirla.
- Ensayado: `h1.py`, E2E `manager.e2e.ts`.

## 3. Horarios y empleados (con y sin email)
1. *Gestión → Horarios*: política con zona IANA (p. ej. `Europe/Madrid`) y si la pausa computa como trabajo,
   según la [checklist de convenio y pausas](legal/CHECKLIST_CONVENIO_PAUSAS.md). Las versiones no son
   retroactivas.
2. *Gestión → Empleados*: alta con código interno y nombre visible; vincular la membresía si la persona tiene
   cuenta; asignar política. Sin política vigente el fichaje se rechaza (`POLICY_REQUIRED`).
3. Personas **sin email**: sin membresía; fichan en el kiosco con código + PIN ([SIN_EMAIL](legal/SIN_EMAIL.md)).
- Ensayado: `h2.py`, E2E `manager.e2e.ts`.

## 4. Kiosco
1. *Gestión → Kioscos → Preparar*: el navegador del gestor genera una clave RSA local; el servidor devuelve la
   credencial técnica del dispositivo **cifrada** para esa clave. Se configura en el dispositivo en `/kiosco`
   (la credencial se entrega en mano, nunca por email o chat).
2. *Gestión → Empleados → PIN de kiosco*: genera un PIN de 8 dígitos cifrado para el gestor, que lo entrega en
   mano; el PIN nunca se guarda en claro ni se puede recuperar (solo resetear).
3. Límites: 5 fallos por persona, 30 por dispositivo y 60 por red en 15 minutos. Tras el borde la red es
   **compartida por todos los kioscos de la empresa** (SEC-H4-01): un abuso puede bloquear 15 min la
   identificación en kiosco de toda la empresa → `KIOSK_AUTH_ABUSE` y [contingencia](legal/CONTINGENCIA.md).
- Ensayado: `h4.py`, `kio_h6.py`, E2E `kiosk.e2e.ts`, `tests/integration/h7_edge.py` (a través del borde).

## 5. Fichajes, pausas y salida de pausa
- Web (*Registro*) o kiosco: solo se ofrecen las acciones legales del estado (fuera → entrada; trabajando →
  pausa o salida; en pausa → fin de pausa o salida). Salir en pausa cierra la jornada sin inventar el fin de
  pausa.
- Solo el recibo del servidor confirma un fichaje (acción, hora del servidor, estado). Sin respuesta =
  **resultado desconocido**: «Comprobar resultado» reenvía la misma petición (misma clave), nunca una nueva.
- Ensayado: `h2.py`, E2E `employee.e2e.ts`/`kiosk.e2e.ts`, carga `tests/integration/h7_load.py`.

## 6. Correcciones con aprobación independiente
1. La persona (*Mis correcciones*) o un gestor presenta la propuesta (añadir, sustituir, anular, jornada que
   falta) con motivo obligatorio.
2. Otro gestor la decide en *Gestión → Correcciones*. El sistema impide la autoaprobación y la decisión sobre la
   propia jornada; los originales permanecen y el cambio queda como ajuste auditado.
- Ensayado: `h3.py`, E2E `employee.e2e.ts`/`manager.e2e.ts`.

## 7. Exportación mensual y entrega controlada
1. Mensual: *Gestión → Exportaciones* (o *Exportar mi registro* para la propia persona): rango y persona
   opcional. El worker genera un paquete CSV + JSON + PDF (originales, correcciones y totales) con manifiesto y
   huella, que se conserva 24 horas en un bucket privado; cada descarga pide un enlace firmado de 5 minutos como
   máximo a través del borde (`/gateway/export-link`).
2. Entrega a **representantes** o a la **Inspección de Trabajo**: registrar la entrega (tipo de destinatario,
   referencia del justificante, finalidad) desde la exportación; queda auditada con el digest del objeto.
   Procedimientos: [REPRESENTANTES](legal/REPRESENTANTES.md), [INSPECCION](legal/INSPECCION.md).
- Ensayado: `h5.py`, E2E `manager.e2e.ts`, firmador a través del borde en `h7_edge.py`.

## 8. Acceso de la persona trabajadora
*Mi registro* muestra originales, correcciones aprobadas, incidencias abiertas y totales informativos; la
persona puede exportar su registro. Personas sin cuenta: copia a petición según
[ACCESO_TRABAJADOR](legal/ACCESO_TRABAJADOR.md).

## 9. Bajas y revocaciones
- Persona: *Gestión → Personas → retirar acceso* (efecto inmediato aunque su sesión siga abierta) y, si deja de
  fichar, desactivar el empleado. La historia se conserva.
- Dispositivo: *Gestión → Kioscos → Revocar* (inmediato; ensayado en el [incidente IR-01](drills/IR-2026-09-28.md)).
- Credencial comprometida de una cuenta: revocar la membresía (pierde el acceso a la empresa al instante, aunque
  su JWT siga vigente) y, si la identidad no pertenece a otras empresas, bloquearla en Supabase Auth (ban) y
  forzar el cambio de contraseña.
- Cambio de OWNER: *Transferir propiedad* (el anterior pasa a ADMIN).
- Baja de la empresa: [BAJA_CLIENTE](legal/BAJA_CLIENTE.md) y la checklist de baja.

## 10. Contingencia
Si el sistema no está disponible: [CONTINGENCIA](legal/CONTINGENCIA.md) (registro alternativo de la empresa y
posterior **corrección aprobada**, nunca edición de originales). La app no admite fichajes offline diferidos.

## 11. Incidentes y recuperación
- Alertas: CRITICAL → página a la guardia; WARNING → ticket ([RUNBOOKS](RUNBOOKS.md)). Incidentes de seguridad:
  [INCIDENTES](legal/INCIDENTES.md), con el guion ensayado en [IR-2026-09-28](drills/IR-2026-09-28.md).
- Restauración: `scripts/restore_database.sh` sobre un proyecto vacío y aislado, reaplicación del journal
  independiente y validación (REC-01..03, `tests/integration/rec.py`). Si queda un PREPARED sin resolver: **no se
  reabre** y no se deduce ningún commit ([RECOVERY](RECOVERY.md)).
- Reapertura: invariantes sin CRITICAL y canary PASS, autorizada por la persona responsable.

## 12. Seguimiento del piloto
Semanal: alertas y tickets, estado de backups y restores de ensayo, invariantes, peticiones de soporte (sin
datos personales). Fin del piloto: aceptación escrita de la empresa o baja según el apartado 9.
