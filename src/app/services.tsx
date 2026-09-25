import { createContext, useContext } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config';

export interface Services { config: AppConfig; client: SupabaseClient }
export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('Services unavailable');
  return services;
}
