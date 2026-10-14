import { handleInvitation } from './handler.ts';

// Hosted Supabase Edge Function. Config, sender and provider token must be
// supplied through the platform secret store; never via public VITE_ variables.
Deno.serve((request: Request) => handleInvitation(request, (name) => Deno.env.get(name)));
