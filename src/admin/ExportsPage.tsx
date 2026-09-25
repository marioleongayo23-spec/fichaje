import { useCurrentTenant } from '../app/tenant';
import { ExportPanel } from '../employee/ExportPanel';
import { Loading, Notice, PageHeader } from '../ui/components';
import { useDirectory } from './data';

export function ExportsPage() {
  const tenant = useCurrentTenant();
  const directory = useDirectory();
  return (
    <>
      <PageHeader title="Exportaciones">
        <p>Paquete de evidencia de la organización o de una persona. La autorización se revalida en el servidor al generar y al descargar.</p>
      </PageHeader>
      {directory.loading && <Loading />}
      {directory.error && <Notice tone="error" title={directory.error} />}
      {directory.data && <ExportPanel employees={directory.data.employees} ownEmployeeId={tenant.current.employee?.id ?? null} />}
    </>
  );
}

export function OwnExportPage() {
  const tenant = useCurrentTenant();
  const employee = tenant.current.employee;
  return (
    <>
      <PageHeader title="Exportar mi registro">
        <p>Descarga una copia de tu registro de jornada con fichajes originales, correcciones y totales.</p>
      </PageHeader>
      {employee ? <ExportPanel employees={null} ownEmployeeId={employee.id} />
        : <Notice tone="info" title="Tu cuenta no tiene ficha de empleado en esta organización." />}
    </>
  );
}
