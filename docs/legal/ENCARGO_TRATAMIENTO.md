# Contrato de encargo de tratamiento (art. 28 RGPD) — PLANTILLA REVISABLE

> Plantilla H7 (2026-09-28) para revisión jurídica. No es asesoramiento jurídico. Completar todos los
> `[[…]]` con datos reales verificados; no usar en producción sin firma de ambas partes.

## Partes
- **Responsable del tratamiento** ("la Empresa"): `[[RAZÓN SOCIAL EMPRESA]]`, CIF `[[CIF EMPRESA]]`, domicilio
  `[[DOMICILIO EMPRESA]]`, representada por `[[NOMBRE Y CARGO]]`. Contacto de protección de datos / DPD:
  `[[CONTACTO DPD EMPRESA]]`.
- **Encargado del tratamiento** ("el Proveedor"): `[[RAZÓN SOCIAL PROVEEDOR]]`, CIF `[[CIF PROVEEDOR]]`, domicilio
  `[[DOMICILIO PROVEEDOR]]`. Contacto de protección de datos / DPD: `[[CONTACTO DPD PROVEEDOR]]`.

## 1. Objeto, duración, naturaleza y finalidad (art. 28.3 RGPD)
- **Objeto**: prestación del servicio de registro de jornada "Fichaje" (aplicación web/PWA y kiosco) para que la
  Empresa cumpla su obligación de registro diario de jornada (art. 34.9 ET) y, cuando proceda, los arts. 12.4.c y
  35.5 ET.
- **Duración**: la del contrato principal `[[REFERENCIA CONTRATO DE SERVICIO]]`, más el periodo de devolución de la
  cláusula 10.
- **Naturaleza de las operaciones**: registro, conservación, consulta, corrección con aprobación independiente,
  exportación, entrega controlada, bloqueo (legal hold) y supresión al vencer los plazos.
- **Finalidad**: exclusivamente el registro de jornada y la puesta a disposición de las personas trabajadoras,
  sus representantes y la Inspección de Trabajo. **Excluidas**: control de productividad, geolocalización,
  biometría, fotografías, nóminas, vacaciones y cualquier otra finalidad.

## 2. Tipos de datos y categorías de interesados
- **Interesados**: personas trabajadoras de la Empresa; personas usuarias gestoras (OWNER/ADMIN).
- **Datos**: nombre para mostrar y código interno del empleado; email de acceso cuando la persona tiene cuenta
  (opcional: las personas sin email usan kiosco); marcas de entrada, pausa, fin de pausa y salida con hora del
  servidor; sesiones; solicitudes y decisiones de corrección con su motivo; clasificaciones de horas declaradas
  por la Empresa; política horaria aplicada; evidencias de auditoría (autor, acción, instante); identificadores
  técnicos de dispositivos de kiosco; datos técnicos mínimos de seguridad (resumen HMAC de la IP de red del
  kiosco, contadores de intentos). **No se tratan** categorías especiales de datos (art. 9 RGPD).

## 3. Obligaciones del Proveedor (art. 28.3.a–h RGPD)
1. Tratar los datos **solo siguiendo instrucciones documentadas** de la Empresa (este contrato y la configuración
   del servicio), incluidas las transferencias (cláusula 7). Si una instrucción infringe la normativa, informará
   inmediatamente a la Empresa.
2. **Confidencialidad** de las personas autorizadas (compromiso firmado u obligación legal).
3. **Medidas de seguridad** del art. 32 RGPD: anexo I.
4. **Subencargados**: solo los del [inventario](SUBENCARGADOS.md), con contrato que imponga las mismas
   obligaciones; aviso previo de cambios con `[[PLAZO PREAVISO, p. ej. 30 días]]` para que la Empresa pueda
   oponerse (autorización general por escrito, art. 28.2).
5. **Asistencia en derechos** de los interesados (arts. 12–22): herramientas del servicio y
   [procedimiento](DERECHOS.md); respuesta a solicitudes reenviadas en `[[PLAZO ASISTENCIA]]`.
6. **Asistencia en arts. 32–36**: seguridad, notificación de violaciones ([procedimiento](INCIDENTES.md)), EIPD
   y consulta previa ([checklist](CHECKLIST_EIPD.md)).
7. **Fin del servicio**: devolución y/o supresión según [BAJA_CLIENTE.md](BAJA_CLIENTE.md), salvo conservación
   exigida por el Derecho de la Unión o de los Estados miembros.
8. **Información y auditorías**: poner a disposición la información necesaria para demostrar el cumplimiento y
   permitir auditorías de la Empresa o de un auditor autorizado con `[[PREAVISO Y FRECUENCIA]]`.
9. **Registro de actividades de tratamiento** como encargado (art. 30.2 RGPD).

## 4. Obligaciones de la Empresa
- Base jurídica y organización del registro de jornada conforme al art. 34.9 ET (negociación colectiva o acuerdo
  de empresa o, en su defecto, decisión empresarial previa consulta con la representación legal).
- Información a las personas trabajadoras ([plantilla](INFORMACION_EMPLEADOS.md)) y a su representación.
- Configuración de políticas horarias, pausas computables y clasificación de horas conforme a su convenio
  ([checklist](CHECKLIST_CONVENIO_PAUSAS.md)).
- Designar gestores, custodiar credenciales y PIN de kiosco, y decidir las correcciones.
- Notificar a la autoridad de control y, en su caso, a los interesados las violaciones de seguridad (arts. 33–34).

## 5. Notificación de violaciones de seguridad
El Proveedor notificará a la Empresa **sin dilación indebida** (art. 33.2 RGPD) y en todo caso en
`[[PLAZO CONTRACTUAL, p. ej. 24 h]]` desde que tenga conocimiento, con la información del art. 33.3 disponible
en ese momento, por `[[CANAL DE NOTIFICACIÓN]]`.

## 6. Localización
Datos primarios del candidato Supabase en `eu-west-1` (Irlanda, UE). La contratación y el inventario de transferencias deben validarse antes del primer cliente. Ver [LOCALIZACION_TRANSFERENCIAS.md](LOCALIZACION_TRANSFERENCIAS.md).

## 7. Transferencias internacionales
Solo con garantías del capítulo V RGPD (decisión de adecuación, cláusulas contractuales tipo u otra garantía
válida), documentadas por subencargado en el inventario.

## 8. Responsabilidad y limitaciones
`[[CLÁUSULAS DE RESPONSABILIDAD Y SEGUROS — a redactar por asesoría]]`. El Proveedor **no promete SLA,
RPO ni RTO comerciales** hasta su medición en producción; los objetivos del piloto (RPO ≤ 24 h, RTO ≤ 8 h) son
objetivos técnicos, no garantías.

## 9. Ley aplicable y jurisdicción
`[[LEY Y JURISDICCIÓN]]`.

## 10. Devolución y supresión al finalizar
Ver [BAJA_CLIENTE.md](BAJA_CLIENTE.md): exportación completa con manifiesto de integridad SHA-256 (no firma electrónica cualificada), entrega con recibo,
supresión en base activa en `[[PLAZO]]` y desaparición de las copias cifradas por rotación (35 días, decisión
técnica), con certificado de supresión.

## Anexo I — Medidas técnicas y organizativas

H1–H7 acreditan implementación y pruebas sintéticas. La activación remota de backup/journal, guardia y candidato completo sigue pendiente en PREPROD-01; este anexo no afirma que dichas operaciones estén activas.
| Medida | Implementación (evidencia en `CURRENT_STATE.md`) |
|---|---|
| Aislamiento por empresa | `organization_id` + RLS forzada en todas las tablas; pruebas cruzadas de dos empresas × tres roles |
| Mínimo privilegio | Roles técnicos NOLOGIN/NOBYPASSRLS; RPC con autorización en servidor |
| Integridad del registro | Originales inmutables, correcciones append-only con aprobación independiente, auditoría transaccional |
| Hora del servidor | El cliente nunca fija la hora del fichaje |
| Kiosco sin email | Código + PIN Argon2id con pepper externo, límites 5/30/60, challenge de un uso |
| Cifrado en tránsito | TLS en el borde (HSTS) y verify-full en conexiones técnicas a PostgreSQL |
| Copias | Pipeline de backup lógico cifrado con age y restore ensayado en CI; custodia, destino y ensayo del candidato pendientes PRE-07 |
| Recuperación | Journal independiente de bajas, retenciones y purgas implementado; instancia remota y restore del candidato pendientes PRE-07 |
| Observabilidad sin datos personales | Eventos por lista blanca, alertas sin PII, canaries sintéticos |
| Minimización | Sin biometría, fotos ni geolocalización; IP de red solo como HMAC por empresa |
| Retención | Purga laboral autorizada al vencer plazos, legal holds, manifiestos |
