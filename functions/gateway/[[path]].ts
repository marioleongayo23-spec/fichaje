// Cloudflare Pages Function for /gateway/* (H7). All logic lives in edge/gateway.ts.
import { handleGateway, type EdgeEnv } from '../../edge/gateway';

export const onRequest = (context: { request: Request; env: EdgeEnv }): Promise<Response> => handleGateway(context.request, context.env);
