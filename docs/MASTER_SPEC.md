# Especificación V1 — contrato, no funcionalidad implementada
## Alcance
Empresas españolas independientes; una identidad Auth puede pertenecer a varias organizaciones.
Un empleado existe sin identidad Auth ni email; usa kiosco. Sin cuentas ficticias compartidas.
Entrada, inicio de pausa, fin de pausa y salida; varias jornadas partidas y turnos nocturnos.
Consulta propia, administración de miembros, solicitudes de corrección, exportaciones y evidencias.
No nóminas, vacaciones, biometría, fotografías, geolocalización ni vigilancia de actividad.
H0 únicamente deja contratos y esqueleto; ninguna garantía funcional se declara validada aquí.

## Autoridad y roles
Roles por organización, nunca globales. OWNER gestiona ADMIN y transferencia de propiedad;
ADMIN gestiona EMPLOYEE, dispositivos, revisiones e informes; EMPLOYEE solo sus registros y solicitudes.
OWNER/ADMIN solo fichan por sí mismos si tienen empleado asociado. Una corrección administrativa
no se disfraza de fichaje del empleado. Un OWNER activo mínimo; transferencia atómica, sin autopromoción.
Desactivar acceso no borra registros ni identidad histórica del autor.

## Máquina de estados autoritativa
| Estado previo | Acción | Estado siguiente |
|---|---|---|
| OUT | CLOCK_IN | WORKING |
| WORKING | BREAK_START | PAUSED |
| PAUSED | BREAK_END | WORKING |
| WORKING | CLOCK_OUT | OUT |
| PAUSED | CLOCK_OUT | OUT |
Toda otra combinación se rechaza sin cambios. Salida en pausa cierra el intervalo de pausa
con el mismo instante que la salida; no inventa BREAK_END. Entrada crea session_id;
resto exige la sesión abierta. Puede haber múltiples sesiones en un día, nunca solapadas.
No cierre automático a medianoche, por duración ni por falta de conectividad.
Una sesión incompleta se informa como incidencia, nunca como cero horas.
Tiempo trabajado = intervalos WORKING + pausas computables según política versionada;
mostrar siempre duración bruta, pausa, neta y computable, sin redondear el original.

## Tiempo y orden
`timestamptz` UTC con `clock_timestamp()` una sola vez después de obtener el bloqueo.
Cliente no envía tiempo efectivo en fichaje ordinario. Se conserva zona IANA de la sesión
(Europe/Madrid o Atlantic/Canary, configurable por centro), offset solo en exportación.
`sequence` por empleado determina orden; si reloj servidor retrocede respecto al último evento,
rechazar con CLOCK_REGRESSION y alertar, sin inventar una hora. Igual instante es permitido;
intervalos cero se muestran. Cálculos en UTC; presentación local, días DST de 23/25 horas.
Turno atribuido al día local de entrada, con desglose por día natural para informes.

## Operación
RPC devuelve event_id, session_id, server_at, state, version, request_id tras commit.
Confirmación visual futura únicamente después del ACK. Timeout: resultado desconocido;
consultar/reintentar con la misma clave. V1 sin fichajes offline ni sincronización de horas del cliente.
Durante caída: procedimiento de contingencia de la empresa y posterior solicitud de corrección marcada.
PWA futura cachea solo shell público; jamás sesiones Auth, APIs, PIN, registros o exportaciones.

## Correcciones
Empleado solicita propuesta y motivo; ADMIN/OWNER aprueba o rechaza dejando decisión append-only.
No autoaprobación: un segundo gestor decide; si solo existe un gestor y es afectado, requiere
incorporar otro gestor autorizado. Original nunca cambia. Ver protocolo completo en DATA_MODEL.
Exportación muestra original, ajustes y resultado; discrepancias y estados pendientes visibles.

## Exportación y entrega
CSV UTF-8 de detalle + JSON canónico de evidencia + PDF de lectura y resumen mensual.
Filtro de organización obligatorio, empleado/rango local, versión de esquema, zona, instante de corte,
IDs, autor, fuente, marcas originales y correcciones, política y totales. Consulta consistente REPEATABLE READ;
paginación por clave dentro del mismo snapshot o materialización servidor, nunca mezclar revisiones.
Periodos incompletos resaltados; sin clasificar automáticamente horas extra/complementarias por simple exceso.
Declaraciones de clasificación por gestor, motivadas y versionadas antes de entregar resumen legal.
CSV escapa comillas y neutraliza fórmulas (=,+,-,@,tab,CR) en campos de texto.
Digest SHA-256 del paquete para comprobar integridad, sin llamarlo firma cualificada.
EMPLOYEE exporta propio; ADMIN/OWNER su empresa. Representantes/Inspección reciben entrega controlada
por gestor con alcance y recibo auditados; no enlaces públicos ni un cuarto rol implícito.
Empleados sin email reciben copia impresa o descarga asistida individual, sin exponer directorio en kiosco.
Ficheros temporales privados 24 h, enlace firmado 5 min y autorización al emitirlo; nunca cache pública.

## Límites de lanzamiento
No prometer universalidad sectorial: validar convenio, pausas computables, parciales, turnos y
obligaciones especiales de cada piloto. Bloquea comercialización hasta H7 aprobado.
