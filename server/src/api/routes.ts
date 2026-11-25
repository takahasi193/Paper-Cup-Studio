import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AgentService, AgentEvent, AppError } from '../agent/agent-service.js';
import { parseSlashCompactCommand } from '../agent/compaction.js';
import { validateAndNormalizeImageAttachments } from '../agent/image-attachments.js';
import type { QueuedMessageMode } from '../agent/message-queue.js';

function resolvePackageVersion(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, '../../../package.json'),
    path.resolve(process.cwd(), '../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (typeof parsed?.version === 'string' && parsed.version.trim()) {
          return parsed.version.trim();
        }
      }
    } catch {
      // Try next candidate
    }
  }
  return '0.1.0-beta.1';
}

const APP_VERSION = resolvePackageVersion();

async function readJsonBody(c: any): Promise<Record<string, any> | null> {
  const raw = await c.req.json().catch(() => null);
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, any>)
    : null;
}

function sendErrorResponse(
  c: any,
  err: unknown,
  fallbackStatus: 400 | 500 = 400,
  fallbackMessage = 'Request failed'
) {
  if (err instanceof AppError) {
    const payload: Record<string, unknown> = { error: err.message };
    if (err.code && err.code !== 'NOT_FOUND' && err.code !== 'CONFLICT') {
      payload.code = err.code;
    }
    return c.json(payload, err.status as any);
  }
  const msg = String((err as any)?.message || err || fallbackMessage);
  if (msg.startsWith('NOT_FOUND:')) {
    return c.json({ error: msg.slice('NOT_FOUND:'.length).trim() }, 404);
  }
  if (msg.startsWith('CONFLICT:')) {
    return c.json({ error: msg.slice('CONFLICT:'.length).trim() }, 409);
  }
  if (msg.startsWith('TASK_NOT_RUNNING:')) {
    return c.json(
      { error: msg.slice('TASK_NOT_RUNNING:'.length).trim(), code: 'TASK_NOT_RUNNING' },
      409
    );
  }
  if (msg.startsWith('TURN_NOT_RUNNING:')) {
    return c.json(
      { error: msg.slice('TURN_NOT_RUNNING:'.length).trim(), code: 'TURN_NOT_RUNNING' },
      409
    );
  }
  if (msg.startsWith('CONFLICT_DIRECT_SUBAGENT:')) {
    return c.json(
      {
        error: msg.slice('CONFLICT_DIRECT_SUBAGENT:'.length).trim(),
        code: 'CONFLICT_DIRECT_SUBAGENT',
      },
      409
    );
  }
  return c.json({ error: msg }, fallbackStatus);
}

function parseQueueMode(raw: unknown, defaultMode: QueuedMessageMode = 'steer'): QueuedMessageMode | null {
  if (raw === undefined || raw === null || raw === '') return defaultMode;
  if (raw === 'steer' || raw === 'followUp') return raw;
  return null;
}

export function createApiRouter(agentService: AgentService): Hono {
  const app = new Hono();

  // フロントエンド開発用の CORS を有効化（例: localhost:5173 上の Vite）
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  app.get('/health', (c) => {
    return c.json({ status: 'ok', version: APP_VERSION });
  });

  app.get('/api/workspaces', (c) => {
    return c.json(agentService.getWorkspaces());
  });

  app.post('/api/workspaces/select', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot switch workspace while a turn is in progress.' }, 409);
    }
    const body = await readJsonBody(c);
    if (!body || typeof body.workspace !== 'string' || !body.workspace.trim()) {
      return c.json({ error: 'Missing workspace parameter' }, 400);
    }
    try {
      agentService.setWorkspace(body.workspace);
      return c.json({ ok: true, ...agentService.getWorkspaces() });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.post('/api/workspaces/remove', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot remove workspace while a turn is in progress.' }, 409);
    }
    const body = await readJsonBody(c);
    if (!body || typeof body.workspace !== 'string' || !body.workspace.trim()) {
      return c.json({ error: 'Missing workspace parameter' }, 400);
    }
    try {
      const updated = agentService.removeWorkspace(body.workspace);
      return c.json({ ok: true, ...updated });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 500);
    }
  };

  app.get('/api/session/history', handleSessionHistory);
  app.get('/api/sessions', handleSessionHistory);

  app.post('/api/session/new', handleNewSession);
  app.post('/api/sessions/new', handleNewSession);

  app.post('/api/session/compact', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const focus = typeof body?.focus === 'string' ? body.focus : undefined;
    try {
      const result = await agentService.compactMainSession(focus);
      return c.json(result, result.status === 'queued' ? 202 : 200);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to compact session');
    }
  });

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
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
    }
  });

  app.post('/api/models/key', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawProvider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : '';
    const customModel = typeof body?.customModel === 'string' ? body.customModel.trim() : undefined;
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : undefined;
    const useStored = body?.useStored === true;
    const clear = body?.clear === true;
    if ((useStored || clear) && (!rawProvider || rawProvider.toLowerCase() === 'auto')) {
      return c.json({ error: 'Missing provider parameter' }, 400);
    }
    const provider = rawProvider || (apiKey.trim() ? 'auto' : '');
    if (!provider) {
      return c.json({ error: 'Missing provider parameter' }, 400);
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot update API key while a turn is in progress.' }, 409);
    }
    try {
      const state = await agentService.setProviderApiKey(provider, apiKey, customModel, {
        useStored,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(clear ? { clear: true } : {}),
      });
      return c.json({ ok: true, ...state });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
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
      return sendErrorResponse(c, err, 400);
    }
  });

  app.get('/api/translator/config', (c) => {
    try {
      return c.json(agentService.getTranslatorConfigState());
    } catch (err: any) {
      return sendErrorResponse(c, err, 500);
    }
  });

  app.post('/api/translator/config', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot update translator configuration while a turn is in progress.' }, 409);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Invalid translator configuration payload.' }, 400);
    }
    try {
      const state = await agentService.updateTranslatorConfig(body);
      return c.json({ ok: true, ...state });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.post('/api/translator/probe', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey : undefined;
    const ollamaPath = typeof body?.ollamaPath === 'string' ? body.ollamaPath : undefined;
    const autoStartOllama = typeof body?.autoStartOllama === 'boolean' ? body.autoStartOllama : undefined;
    const concurrency = typeof body?.concurrency === 'number' ? body.concurrency : undefined;
    if (!baseUrl) {
      return c.json({ error: 'Missing baseUrl parameter' }, 400);
    }
    try {
      const result = await agentService.probeLocalTranslator(baseUrl, apiKey, {
        ollamaPath,
        autoStartOllama,
        concurrency,
      });
      return c.json(result);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.post('/api/translator/ollama/pick', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot pick Ollama executable while a turn is in progress.' }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const initialPath = typeof body?.initialPath === 'string' ? body.initialPath : undefined;
    try {
      const result = await agentService.pickOllamaBinary(initialPath);
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.get('/api/translator/ollama/status', async (c) => {
    const baseUrl = c.req.query('baseUrl') || undefined;
    const ollamaPath = c.req.query('ollamaPath') ?? undefined;
    try {
      const status = await agentService.getLocalOllamaStatus({ baseUrl, ollamaPath });
      return c.json(status);
    } catch (err: any) {
      return sendErrorResponse(c, err, 500);
    }
  });

  app.post('/api/translator/ollama/start', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot start or restart Ollama while a turn is in progress.' }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl : undefined;
    const ollamaPath = typeof body?.ollamaPath === 'string' ? body.ollamaPath : undefined;
    const concurrency = typeof body?.concurrency === 'number' ? body.concurrency : undefined;
    const forceRestart = typeof body?.forceRestart === 'boolean' ? body.forceRestart : false;
    try {
      const result = await agentService.startLocalOllama({
        baseUrl,
        ollamaPath,
        concurrency,
        forceRestart,
      });
      return c.json(result);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.get('/api/smoke/config', (c) => {
    try {
      return c.json(agentService.getSmokeConfigState());
    } catch (err: any) {
      return sendErrorResponse(c, err, 500);
    }
  });

  app.post('/api/smoke/config', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot update smoke test configuration while a turn is in progress.' }, 409);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Invalid smoke test configuration payload.' }, 400);
    }
    try {
      const state = agentService.updateSmokeConfig(body);
      return c.json({ ok: true, ...state });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.post('/api/smoke/pick', async (c) => {
    if (agentService.isBusy()) {
      return c.json({ error: 'Cannot pick smoke test executable while a turn is in progress.' }, 409);
    }
    const body = await c.req.json().catch(() => ({}));
    const tool = body?.tool === 'locale_emulator' ? 'locale_emulator' : 'textractor';
    const initialPath = typeof body?.initialPath === 'string' ? body.initialPath : undefined;
    try {
      const result = await agentService.pickSmokeToolBinary(tool, initialPath);
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }
  });

  app.get('/api/smoke/report', (c) => {
    try {
      return c.json({
        config: agentService.getSmokeConfigState(),
        report: agentService.getLatestSmokeReport(),
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
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

  app.post('/api/subagents/tasks/:taskId/message', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json().catch(() => ({}));
    const rawMessage =
      typeof body?.message === 'string'
        ? body.message
        : typeof body?.prompt === 'string'
          ? body.prompt
          : '';
    let images;
    try {
      images = validateAndNormalizeImageAttachments(body?.images);
    } catch (err: any) {
      return c.json({ error: String(err?.message || err || 'Invalid image attachments') }, 400);
    }
    const parsedCompact = images.length === 0 ? parseSlashCompactCommand(rawMessage) : null;
    if (parsedCompact) {
      try {
        const result = await agentService.compactSubagent(taskId, parsedCompact.focus);
        return c.json(result, result.status === 'queued' ? 202 : 200);
      } catch (err: any) {
        return sendErrorResponse(c, err, 400, 'Failed to compact subagent session');
      }
    }
    try {
      const result = await agentService.startDirectSubagentMessage(taskId, rawMessage, images);
      return c.json({ ok: true, ...result }, 202);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to message subagent task');
    }
  });

  const handleSubagentCompact = async (c: any) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json().catch(() => ({}));
    const focus = typeof body?.focus === 'string' ? body.focus : undefined;
    try {
      const result = await agentService.compactSubagent(taskId, focus);
      return c.json(result, result.status === 'queued' ? 202 : 200);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to compact subagent session');
    }
  };

  app.post('/api/subagents/:taskId/compact', handleSubagentCompact);
  app.post('/api/subagents/tasks/:taskId/compact', handleSubagentCompact);

  app.post('/api/subagents/tasks/:taskId/queue', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json().catch(() => ({}));
    const rawMessage =
      typeof body?.message === 'string'
        ? body.message
        : typeof body?.prompt === 'string'
          ? body.prompt
          : '';
    let images;
    try {
      images = validateAndNormalizeImageAttachments(body?.images);
    } catch (err: any) {
      return c.json({ error: String(err?.message || err || 'Invalid image attachments') }, 400);
    }
    const parsedCompact = images.length === 0 ? parseSlashCompactCommand(rawMessage) : null;
    if (parsedCompact) {
      try {
        const result = await agentService.compactSubagent(taskId, parsedCompact.focus);
        return c.json(result, result.status === 'queued' ? 202 : 200);
      } catch (err: any) {
        return sendErrorResponse(c, err, 400, 'Failed to compact subagent session');
      }
    }
    const mode = parseQueueMode(body?.mode, 'steer');
    if (!mode) {
      return c.json({ error: 'Invalid queue mode; expected "steer" or "followUp".' }, 400);
    }
    try {
      const result = await agentService.enqueueSubagentMessage(taskId, rawMessage, mode, images);
      return c.json({ ok: true, ...result }, 202);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to queue subagent message');
    }
  });

  app.patch('/api/subagents/tasks/:taskId/queue/:itemId', async (c) => {
    const taskId = c.req.param('taskId');
    const itemId = c.req.param('itemId');
    const body = await c.req.json().catch(() => ({}));
    const mode = parseQueueMode(body?.mode);
    if (!mode || body?.mode === undefined) {
      return c.json({ error: 'Missing or invalid mode; expected "steer" or "followUp".' }, 400);
    }
    try {
      const result = await agentService.switchSubagentQueueItemMode(taskId, itemId, mode);
      if (!result.found) {
        return c.json(
          {
            ok: false,
            code: result.alreadyDelivered ? 'ALREADY_DELIVERED' : 'NOT_FOUND',
            queue: result.queue,
          },
          result.alreadyDelivered ? 409 : 404
        );
      }
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to update subagent queue item');
    }
  });

  app.delete('/api/subagents/tasks/:taskId/queue/:itemId', async (c) => {
    const taskId = c.req.param('taskId');
    const itemId = c.req.param('itemId');
    try {
      const result = await agentService.removeSubagentQueueItem(taskId, itemId);
      if (!result.found) {
        return c.json(
          {
            ok: false,
            code: result.alreadyDelivered ? 'ALREADY_DELIVERED' : 'NOT_FOUND',
            removed: null,
            queue: result.queue,
          },
          result.alreadyDelivered ? 409 : 404
        );
      }
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to remove subagent queue item');
    }
  });

  app.delete('/api/subagents/tasks/:taskId/queue', async (c) => {
    const taskId = c.req.param('taskId');
    try {
      const result = await agentService.clearSubagentQueue(taskId);
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to clear subagent queue');
    }
  });

  app.post('/api/subagents/tasks/:taskId/abort', (c) => {
    const taskId = c.req.param('taskId');
    const result = agentService.abortDirectSubagentTaskWithResult(taskId);
    return c.json({ ok: true, aborted: result.aborted, restoredDraft: result.restoredDraft });
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

  app.get('/api/vn/forms', (c) => {
    try {
      return c.json(agentService.getChatFormsState());
    } catch (err: any) {
      return sendErrorResponse(c, err, 500, 'Failed to list chat forms');
    }
  });

  app.post('/api/vn/forms/:formId/submit', async (c) => {
    const formId = c.req.param('formId');
    const body = await readJsonBody(c);
    if (!body || !Array.isArray(body.items)) {
      return c.json({ error: 'Missing items array' }, 400);
    }
    const autoContinue = body.autoContinue !== false;
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : undefined;
    const dismissedNames = Array.isArray(body.dismissedNames)
      ? body.dismissedNames.map((v: unknown) => String(v ?? '').trim()).filter(Boolean)
      : undefined;
    try {
      const result = await agentService.submitCharacterForm(formId, {
        items: body.items,
        ...(dismissedNames ? { dismissedNames } : {}),
        autoContinue,
        model: requestedModel,
      });
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to submit character form');
    }
  });

  app.post('/api/vn/forms/:formId/cancel', (c) => {
    const formId = c.req.param('formId');
    try {
      const form = agentService.cancelWorkspaceChatForm(formId);
      return c.json({ ok: true, form });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to cancel chat form');
    }
  });

  app.get('/api/turns/stream', (c) => {
    return streamSSE(c, async (stream) => {
      const safeWrite = (event: string, data: string) => {
        try {
          void Promise.resolve(stream.writeSSE({ event, data })).catch(() => {
            // Ignore closed SSE stream write failures
          });
        } catch {
          // Ignore synchronous closed SSE stream write failures
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
    const body = await readJsonBody(c);
    if (!body) {
      return c.json({ error: 'Missing prompt' }, 400);
    }
    const rawPrompt = typeof body.prompt === 'string' ? body.prompt : '';
    let images;
    try {
      images = validateAndNormalizeImageAttachments(body.images);
    } catch (err: any) {
      return c.json({ error: String(err?.message || err || 'Invalid image attachments') }, 400);
    }
    if (!rawPrompt.trim() && images.length === 0) {
      return c.json({ error: 'Missing prompt' }, 400);
    }
    const parsedCompact = images.length === 0 ? parseSlashCompactCommand(rawPrompt) : null;
    if (parsedCompact) {
      try {
        const result = await agentService.compactMainSession(parsedCompact.focus);
        return c.json(result, result.status === 'queued' ? 202 : 200);
      } catch (err: any) {
        return sendErrorResponse(c, err, 400, 'Failed to compact session');
      }
    }
    if (agentService.isBusy()) {
      return c.json({ error: 'A turn is already in progress.' }, 409);
    }
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : undefined;
    try {
      await agentService.startTurn(rawPrompt, {
        model: requestedModel,
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400);
    }

    return c.json({ ok: true, status: 'started' });
  });

  app.post('/api/turns/queue', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawPrompt =
      typeof body?.prompt === 'string'
        ? body.prompt
        : typeof body?.message === 'string'
          ? body.message
          : '';
    let images;
    try {
      images = validateAndNormalizeImageAttachments(body?.images);
    } catch (err: any) {
      return c.json({ error: String(err?.message || err || 'Invalid image attachments') }, 400);
    }
    const parsedCompact = images.length === 0 ? parseSlashCompactCommand(rawPrompt) : null;
    if (parsedCompact) {
      try {
        const result = await agentService.compactMainSession(parsedCompact.focus);
        return c.json(result, result.status === 'queued' ? 202 : 200);
      } catch (err: any) {
        return sendErrorResponse(c, err, 400, 'Failed to compact session');
      }
    }
    const mode = parseQueueMode(body?.mode, 'steer');
    if (!mode) {
      return c.json({ error: 'Invalid queue mode; expected "steer" or "followUp".' }, 400);
    }
    try {
      const result = await agentService.enqueueMainTurnMessage(rawPrompt, mode, images);
      return c.json({ ok: true, ...result }, 202);
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to queue message');
    }
  });

  app.patch('/api/turns/queue/:itemId', async (c) => {
    const itemId = c.req.param('itemId');
    const body = await c.req.json().catch(() => ({}));
    const mode = parseQueueMode(body?.mode);
    if (!mode || body?.mode === undefined) {
      return c.json({ error: 'Missing or invalid mode; expected "steer" or "followUp".' }, 400);
    }
    try {
      const result = await agentService.switchMainQueueItemMode(itemId, mode);
      if (!result.found) {
        return c.json(
          {
            ok: false,
            code: result.alreadyDelivered ? 'ALREADY_DELIVERED' : 'NOT_FOUND',
            queue: result.queue,
          },
          result.alreadyDelivered ? 409 : 404
        );
      }
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to update queue item');
    }
  });

  app.delete('/api/turns/queue/:itemId', async (c) => {
    const itemId = c.req.param('itemId');
    try {
      const result = await agentService.removeMainQueueItem(itemId);
      if (!result.found) {
        return c.json(
          {
            ok: false,
            code: result.alreadyDelivered ? 'ALREADY_DELIVERED' : 'NOT_FOUND',
            removed: null,
            queue: result.queue,
          },
          result.alreadyDelivered ? 409 : 404
        );
      }
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to remove queue item');
    }
  });

  app.delete('/api/turns/queue', async (c) => {
    try {
      const result = await agentService.clearMainQueue();
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return sendErrorResponse(c, err, 400, 'Failed to clear queue');
    }
  });

  app.post('/api/turns/abort', async (c) => {
    try {
      const result = await agentService.abortTurnWithResult();
      return c.json({ ok: true, aborted: result.aborted, restoredDraft: result.restoredDraft });
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
