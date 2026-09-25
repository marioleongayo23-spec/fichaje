import { startServices } from './support/services';

export default async function globalSetup() {
  await startServices();
}
