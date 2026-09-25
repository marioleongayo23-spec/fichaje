import { stopServices } from './support/services';

export default async function globalTeardown() {
  stopServices();
}
