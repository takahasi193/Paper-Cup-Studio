import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentService, AgentEvent } from '../agent/agent-service.js';

export function createApiRouter(agentService: AgentService): Hono {
  const app = new Hono();

  // フロントエンド開発用の CORS を有効化（例: localhost:5173 上の Vite）
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  app.get('/health', (c) => {
    return c.json({ status: 'ok', version: '0.1.0-beta.1' });
  });

  app.get('/api/workspaces', (c) => {
    return c.json(agentService.getWorkspaces());
  });

  app.post('/api/workspaces/select', async (c) => {
    const body = await c.req.json();
    if (!body.workspace) {
      return c.json({ error: 'Missing workspace parameter' }, 400);
    }
    try {
      agentService.setWorkspace(body.workspace);
      return c.json({ ok: true, ...agentService.getWorkspaces() });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/workspaces/remove', async (c) => {
    const body = await c.req.json();
    if (!body.workspace) {
      return c.json({ error: 'Missing workspace parameter' }, 400);
    }
    try {
      const updated = agentService.removeWorkspace(body.workspace);
      return c.json({ ok: true, ...updated });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/workspaces/pick', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot pick workspace folder while a turn is in progress.' }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const initialDir = typeof body?.initialDir === 'string' ? body.initialDir : undefined;
    try {
      const res = await agentService.pickWorkspaceFolder(initialDir);
      return c.json({ ok: true, canceled: res.canceled, path: res.path });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/api/workspaces/sessions', async (c) => {
    const workspace = (c.req.query('workspace') || '').trim();
    if (!workspace) {
      return c.json({ error: 'Missing workspace parameter' }, 400);
    }
    try {
      const data = await agentService.listRegisteredWorkspaceSessions(workspace);
      return c.json(data);
    } catch (err: any) {
      const msg = String(err?.message || '');
      const status = msg.includes('not registered') ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  app.post('/api/workspaces/open-session', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const workspace = typeof body?.workspace === 'string' ? body.workspace.trim() : '';
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!workspace || !sessionId) {
      return c.json({ error: 'Missing workspace or sessionId parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot switch workspace or session while a turn is in progress.' }, 409);
    }
    try {
      const result = await agentService.openWorkspaceSession(workspace, sessionId);
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      const msg = String(err?.message || '');
      const status = msg.includes('not found') || msg.includes('does not exist') ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  const handleSessionHistory = async (c: any) => {
    try {
      const history = await agentService.getSessionHistory();
      return c.json(history);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  };

  const handleNewSession = async (c: any) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot start a new session while a turn is in progress.' }, 409);
    }
    try {
      const history = await agentService.createNewSession();
      return c.json({ ok: true, ...history });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  };

  app.get('/api/session/history', handleSessionHistory);
  app.get('/api/sessions', handleSessionHistory);

  app.post('/api/session/new', handleNewSession);
  app.post('/api/sessions/new', handleNewSession);

  app.post('/api/sessions/select', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return c.json({ error: 'Missing sessionId parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot switch session while a turn is in progress.' }, 409);
    }
    try {
      const history = await agentService.selectSession(sessionId);
      return c.json({ ok: true, ...history });
    } catch (err: any) {
      const status = String(err?.message || '').includes('not found') ? 404 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  app.post('/api/sessions/delete', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      return c.json({ error: 'Missing sessionId parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot delete session while a turn is in progress.' }, 409);
    }
    try {
      const history = await agentService.deleteSession(sessionId);
      return c.json({ ok: true, ...history });
    } catch (err: any) {
      const status = String(err?.message || '').includes('not found') ? 404 : 400;
      return c.json({ error: err.message }, status);
    }
  });

  app.get('/api/models', async (c) => {
    try {
      const state = await agentService.getModelsState();
      return c.json(state);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post('/api/models/select', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!model) {
      return c.json({ error: 'Missing model parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot switch model while a turn is in progress.' }, 409);
    }
    try {
      const state = await agentService.selectModel(model);
      return c.json({ ok: true, ...state });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/models/key', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawProvider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';
    const customModel = typeof body?.customModel === 'string' ? body.customModel.trim() : undefined;
    const provider = rawProvider || (apiKey.trim() ? 'auto' : '');
    if (!provider) {
      return c.json({ error: 'Missing provider parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot update API key while a turn is in progress.' }, 409);
    }
    try {
      const state = await agentService.setProviderApiKey(provider, apiKey, customModel);
      return c.json({ ok: true, ...state });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/models/key/detect', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';
    if (!apiKey.trim()) {
      return c.json({ error: 'Missing apiKey parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot detect provider while a turn is in progress.' }, 409);
    }
    try {
      const result = await agentService.detectApiKeyProvider(apiKey);
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/models/thinking', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const thinkingLevel = typeof body?.thinkingLevel === 'string' ? body.thinkingLevel.trim() : '';
    if (!thinkingLevel) {
      return c.json({ error: 'Missing thinkingLevel parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot change thinking level while a turn is in progress.' }, 409);
    }
    try {
      const state = await agentService.setThinkingLevel(thinkingLevel);
      return c.json({ ok: true, ...state });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/api/turns/status', (c) => {
    return c.json(agentService.getTurnSyncState());
  });

  app.get('/api/subagents/tasks', (c) => {
    const sessionId = c.req.query('sessionId') || undefined;
    return c.json({ tasks: agentService.listSubagentTasks(sessionId) });
  });

  app.get('/api/subagents/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const task = agentService.getSubagentTask(taskId);
    if (!task) {
      return c.json({ error: 'Subagent task not found' }, 404);
    }
    return c.json(task);
  });

  app.get('/api/engineering/status', async (c) => {
    const refreshParam = c.req.query('refresh') ?? c.req.query('force');
    const forceRefresh = refreshParam === '1' || refreshParam === 'true';
    try {
      const status = await agentService.getEngineeringStatus({ forceRefresh });
      return c.json(status);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get('/api/turns/stream', (c) => {
    return streamSSE(c, async (stream) => {
      const safeWrite = (event: string, data: string) => {
        try {
          void stream.writeSSE({ event, data });
        } catch {
          // Ignore closed SSE stream write failures
        }
      };

      const listener = (event: AgentEvent) => {
        safeWrite(event.type, JSON.stringify(event.data));
      };

      agentService.on('agent_event', listener);
      safeWrite('sync_state', JSON.stringify(agentService.getTurnSyncState()));

      // 15秒ごとのキープアライブハートビート
      const timer = setInterval(() => {
        safeWrite('ping', 'heartbeat');
      }, 15000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          agentService.off('agent_event', listener);
          clearInterval(timer);
          resolve();
        });
      });
    });
  });

  app.post('/api/turns/start', async (c) => {
    const body = await c.req.json();
    if (!body.prompt) {
      return c.json({ error: 'Missing prompt' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'A turn is already in progress.' }, 409);
    }
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : undefined;
    if (requestedModel && !agentService.isCurrentModel(requestedModel)) {
      try {
        await agentService.selectModel(requestedModel);
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    }

    // SSE 経由でストリーミングしながらバックグラウンドでターンを実行
    agentService.executeTurn(body.prompt, { model: requestedModel }).catch((err) => {
      console.error('Turn execution error:', err);
    });

    return c.json({ ok: true, status: 'started' });
  });

  app.post('/api/turns/abort', async (c) => {
    try {
      const aborted = await agentService.abortTurn();
      return c.json({ ok: true, aborted });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Serve compiled web frontend if available (CWD-independent for quick launch & monorepo runs)
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [
    path.resolve(currentDir, '../../../web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(process.cwd(), 'web/dist'),
  ].find((dir) => fs.existsSync(path.join(dir, 'index.html')));

  if (webDist) {
    const serveRoot = (path.relative(process.cwd(), webDist) || '.').replace(/\\/g, '/');
    app.use('/*', serveStatic({ root: serveRoot }));
    app.get('*', (c) => {
      const indexPath = path.join(webDist, 'index.html');
      return c.html(fs.readFileSync(indexPath, 'utf-8'));
    });
  }

  return app;
}
