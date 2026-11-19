import { serve } from '@hono/node-server';
import { config } from './config.js';
import { AgentService } from './agent/agent-service.js';
import { createApiRouter } from './api/routes.js';

const initialWorkspace = process.env.PAPERCUP_WORKSPACE?.trim() || undefined;
const agentService = new AgentService(initialWorkspace);
const app = createApiRouter(agentService);

console.log(`[Paper Cup] Starting Agent Core Server...`);
console.log(`[Paper Cup] Active Workspace: ${agentService.getWorkspace()}`);
console.log(`[Paper Cup] Python Path: ${config.pythonPath}`);

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  },
  (info) => {
    console.log(`[Paper Cup] Server ready at http://${info.address}:${info.port}`);
    void agentService.warmup().catch((err) => {
      console.warn('[Paper Cup] Warmup warning:', err);
    });
  }
);
