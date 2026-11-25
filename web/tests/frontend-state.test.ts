import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyOffsetDeltaChunk,
  reconcileBufferedChunks,
  reconcileOverlayWithSnapshot,
} from '@/lib/subagentStreamReconcile.js';
import {
  isExternalUrl,
  safeUrlTransform,
  splitStableMarkdownBlocks,
} from '@/components/chat/MarkdownContent.js';
import { getActiveSubagentRoles, getToolDisplayLabel } from '@/lib/toolLabels.js';
import {
  compactSession,
  compactSubagent,
  EngineeringStatus,
  parseSlashCompactCommand,
  resolveEngineDisplay,
  submitChatForm,
  updateProviderApiKey,
} from '@/lib/api.js';
import {
  appendCompactionMessageIfMissing,
  ChatMessage,
  MAX_SUBAGENT_TASKS,
  parseSseJson,
  shouldSkipEmptyTurnFinish,
  toCompactionChatMessage,
  upsertSubagentTaskList,
} from '@/hooks/useAgentStream.js';
import {
  formatCompactionTokens,
  getCompactionReasonMeta,
} from '@/components/chat/CompactionDividerCard.js';
import {
  isDefaultLocalOllamaUrl,
  isLoopbackHttpUrl,
} from '@/components/dialogs/SettingsDialog.js';
import {
  estimateDecodedBase64Bytes,
  isSupportedImageMimeType,
  toImageDataUrl,
} from '../src/lib/imageAttachments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_SRC_DIR = path.resolve(__dirname, '..', 'src');

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('subagentStreamReconcile — deterministic offset-based delta reconciliation [WEB-P0-02]', () => {
  it('never swallows legitimate repeated characters (hex offsets and markdown fences)', () => {
    const hex = applyOffsetDeltaChunk(
      { text: '0x0010', offset: 6 },
      { offset: 6, endOffset: 8, delta: '00' }
    );
    assert.equal(hex.changed, true);
    assert.equal(hex.gapDetected, false);
    assert.equal(hex.next.text, '0x001000');
    assert.equal(hex.next.offset, 8);

    const fenceOpen = applyOffsetDeltaChunk(
      { text: '``', offset: 2 },
      { offset: 2, endOffset: 3, delta: '`' }
    );
    assert.equal(fenceOpen.next.text, '```');
    assert.equal(fenceOpen.next.offset, 3);

    const fenceClose = applyOffsetDeltaChunk(
      { text: '```ts\nconst a = 1;\n``', offset: 21 },
      { offset: 21, endOffset: 22, delta: '`' }
    );
    assert.equal(fenceClose.next.text, '```ts\nconst a = 1;\n```');
    assert.equal(fenceClose.next.offset, 22);
  });

  it('ignores stale historical mid-stream deltas instead of duplicating onto longer snapshots', () => {
    const res = applyOffsetDeltaChunk(
      { text: 'ABCD', offset: 4 },
      { offset: 1, endOffset: 3, delta: 'BC' }
    );
    assert.equal(res.changed, false);
    assert.equal(res.gapDetected, false);
    assert.equal(res.next.text, 'ABCD');
    assert.equal(res.next.offset, 4);
  });

  it('slices partial overlaps exactly and signals gapDetected when offset skips ahead', () => {
    const partial = applyOffsetDeltaChunk(
      { text: 'ABCD', offset: 4 },
      { offset: 2, endOffset: 6, delta: 'CDEF' }
    );
    assert.equal(partial.changed, true);
    assert.equal(partial.gapDetected, false);
    assert.equal(partial.next.text, 'ABCDEF');
    assert.equal(partial.next.offset, 6);

    const gap = applyOffsetDeltaChunk(
      { text: 'AB', offset: 2 },
      { offset: 4, endOffset: 6, delta: 'EF' }
    );
    assert.equal(gap.changed, false);
    assert.equal(gap.gapDetected, true);
    assert.equal(gap.next.text, 'AB');
    assert.equal(gap.next.offset, 2);
  });

  it('reconciles thinking and content independently and drops overlay once snapshot catches up', () => {
    const thinkingRec = reconcileBufferedChunks('Step 1', 6, [
      { seq: 2, offset: 6, endOffset: 11, delta: ' -> 2' },
      { seq: 1, offset: 0, endOffset: 4, delta: 'Step' },
    ]);
    assert.equal(thinkingRec.aheadOfSnapshot, true);
    assert.equal(thinkingRec.gapDetected, false);
    assert.equal(thinkingRec.field.text, 'Step 1 -> 2');
    assert.equal(thinkingRec.field.offset, 11);

    const contentRec = reconcileBufferedChunks('offset 0x0010', 13, [
      { seq: 3, offset: 13, endOffset: 15, delta: '00' },
      { seq: 4, offset: 18, endOffset: 20, delta: 'ZZ' }, // gap after 15
    ]);
    assert.equal(contentRec.aheadOfSnapshot, true);
    assert.equal(contentRec.gapDetected, true);
    assert.equal(contentRec.field.text, 'offset 0x001000');
    assert.equal(contentRec.field.offset, 15);

    // While snapshot is behind, verified overlay wins
    const stillAhead = reconcileOverlayWithSnapshot('Step 1', 6, thinkingRec.field);
    assert.equal(stillAhead.aheadOfSnapshot, true);
    assert.equal(stillAhead.field.text, 'Step 1 -> 2');

    // Once snapshot reaches/passes overlay offset, overlay drops cleanly
    const caughtUp = reconcileOverlayWithSnapshot('Step 1 -> 2 done', 16, thinkingRec.field);
    assert.equal(caughtUp.aheadOfSnapshot, false);
    assert.equal(caughtUp.field.text, 'Step 1 -> 2 done');
    assert.equal(caughtUp.field.offset, 16);
  });
});

describe('MarkdownContent — URL safety & streaming block splitter [WEB-P1-09]', () => {
  it('blocks protocol-relative, backslash, and script/data URLs while allowing safe links', () => {
    for (const dangerous of [
      '//evil.example',
      '//evil.example/phish?x=1',
      '  //evil.example/path',
      '/\\evil.example',
      '\\\\evil.example\\share',
      'javascript:alert(1)',
      'JAVASCRIPT:void(0)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///C:/Windows/win.ini',
    ]) {
      assert.equal(safeUrlTransform(dangerous), '', `Expected safeUrlTransform to block: ${dangerous}`);
    }

    assert.equal(safeUrlTransform('/local/path'), '/local/path');
    assert.equal(safeUrlTransform('#sec'), '#sec');
    assert.equal(safeUrlTransform('https://example.com/docs?q=1'), 'https://example.com/docs?q=1');
    assert.equal(safeUrlTransform('http://127.0.0.1:3100/health'), 'http://127.0.0.1:3100/health');
    assert.equal(safeUrlTransform('mailto:dev@example.com'), 'mailto:dev@example.com');

    assert.equal(isExternalUrl('https://example.com'), true);
    assert.equal(isExternalUrl('http://example.com'), true);
    assert.equal(isExternalUrl('//evil.example'), true);
    assert.equal(isExternalUrl('/local/path'), false);
    assert.equal(isExternalUrl('#sec'), false);
    assert.equal(isExternalUrl('mailto:dev@example.com'), false);
  });

  it('keeps loose lists, multi-paragraph blockquotes, and reference-link documents intact while splitting plain paragraphs', () => {
    const orderedList = '1. First item\n\n2. Second item\n\n3. Third item';
    const ordSplit = splitStableMarkdownBlocks(orderedList);
    assert.equal(ordSplit.stable.length, 0);
    assert.equal(ordSplit.tail, orderedList);

    const unorderedList = '- First\n\n  continuation paragraph\n\n- Second';
    const ulSplit = splitStableMarkdownBlocks(unorderedList);
    assert.equal(ulSplit.stable.length, 0);
    assert.equal(ulSplit.tail, unorderedList);

    const blockquote = '> Line one\n\n> Line two';
    const bqSplit = splitStableMarkdownBlocks(blockquote);
    assert.equal(bqSplit.stable.length, 0);
    assert.equal(bqSplit.tail, blockquote);

    const refLinks = 'Read the [guide][doc-ref] carefully.\n\nMore prose.\n\n[doc-ref]: https://example.com';
    const refSplit = splitStableMarkdownBlocks(refLinks);
    assert.equal(refSplit.stable.length, 0);
    assert.equal(refSplit.tail, refLinks);

    const plainProse = 'Paragraph one.\n\nParagraph two.\n\nStreaming tail';
    const proseSplit = splitStableMarkdownBlocks(plainProse);
    assert.deepEqual(proseSplit.stable, ['Paragraph one.', 'Paragraph two.']);
    assert.equal(proseSplit.tail, 'Streaming tail');
  });
});

describe('toolLabels, api.ts, useAgentStream & SettingsDialog helpers [WEB-P1-01/08/15/16/17, WEB-P2-01]', () => {
  it('maps vn_extract_roster and vn_request_character_confirmation to localized tool display labels', () => {
    assert.equal(getToolDisplayLabel('vn_extract_roster'), '提取角色名册');
    assert.equal(getToolDisplayLabel('vn_request_character_confirmation'), '发送角色译名确认表单');
  });

  it('only marks cloud subagent roles active when actually routed to them', () => {
    const localRoles = getActiveSubagentRoles(
      [
        { tool: 'vn_translate_batches', args: {} },
        { tool: 'vn_post_qa_parallel', args: { skipRoleChecker: true } },
      ],
      { translatorMode: 'local_mt' }
    );
    assert.equal(localRoles.has('translator'), false);
    assert.equal(localRoles.has('role-checker'), false);

    const snakeSkipRoles = getActiveSubagentRoles(
      [{ tool: 'vn_post_qa_parallel', args: { skip_role_checker: true } }],
      { translatorMode: 'cloud_subagent' }
    );
    assert.equal(snakeSkipRoles.has('role-checker'), false);

    const cloudRoles = getActiveSubagentRoles(
      [
        { tool: 'vn_translate_batches', args: {} },
        { tool: 'vn_post_qa_parallel', args: {} },
        { tool: 'delegate_task', args: { role: 'reverser' } },
        { tool: 'delegate_task', args: { role: 'completed-role' }, result: { ok: true } },
      ],
      { translatorMode: 'cloud_subagent' }
    );
    assert.equal(cloudRoles.has('translator'), true);
    assert.equal(cloudRoles.has('role-checker'), true);
    assert.equal(cloudRoles.has('reverser'), true);
    assert.equal(cloudRoles.has('completed-role'), false);
  });

  it('prefers structured engineName (preserving spaces like "Wolf RPG") and falls back cleanly on legacy payloads', () => {
    const base: Omit<EngineeringStatus, 'engine' | 'engineId' | 'engineName' | 'engineKnown'> = {
      workspace: 'E:\\Games\\Demo',
      rawStatus: '',
      hasUnpacked: false,
      hasBuild: false,
    };

    const structured = resolveEngineDisplay({
      ...base,
      engine: 'Wolf RPG  wolf  -  Data.wolf  unsupported',
      engineId: 'wolf_rpg',
      engineName: 'Wolf RPG',
      engineKnown: true,
    });
    assert.equal(structured.known, true);
    assert.equal(structured.shortLabel, 'Wolf RPG');
    assert.equal(structured.displayLabel, 'Wolf RPG');

    const unknownStructured = resolveEngineDisplay({
      ...base,
      engine: '未识别到封包。',
      engineId: null,
      engineName: null,
      engineKnown: false,
    });
    assert.equal(unknownStructured.known, false);
    assert.equal(unknownStructured.shortLabel, null);
    assert.equal(unknownStructured.displayLabel, '未识别');

    const legacySpaced = resolveEngineDisplay({
      ...base,
      engine: 'Wolf RPG  wolf  -  Data.wolf',
    });
    assert.equal(legacySpaced.known, true);
    assert.equal(legacySpaced.shortLabel, 'Wolf RPG');

    const loading = resolveEngineDisplay(null);
    assert.equal(loading.known, false);
    assert.equal(loading.displayLabel, '正在识别…');
  });

  it('preserves explicit empty-string baseUrl in updateProviderApiKey payload', async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      capturedBodies.push(JSON.parse(String(init?.body || '{}')));
      return new Response(JSON.stringify({ ok: true, current: null, models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await updateProviderApiKey('magpie', '', undefined, { baseUrl: '' });
      await updateProviderApiKey('magpie', '', undefined, { baseUrl: 'http://127.0.0.1:3425/v1' });
      await updateProviderApiKey('openai', 'sk-test', undefined, {});
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(Object.prototype.hasOwnProperty.call(capturedBodies[0], 'baseUrl'), true);
    assert.equal(capturedBodies[0].baseUrl, '');
    assert.equal(capturedBodies[1].baseUrl, 'http://127.0.0.1:3425/v1');
    assert.equal(Object.prototype.hasOwnProperty.call(capturedBodies[2], 'baseUrl'), false);
  });

  it('forwards dismissedNames and empty 0-character items cleanly in submitChatForm payload', async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({
          ok: true,
          editedCount: 0,
          glossaryEntriesAdded: 0,
          startedTurn: false,
          form: {
            schema: 1,
            formId: 'roster-zero-1',
            kind: 'character_roster',
            status: 'submitted',
            title: '角色译名确认表',
            description: '',
            sessionId: null,
            classifyDigest: 'd1',
            createdAt: '2026-11-22T00:00:00Z',
            updatedAt: '2026-11-22T00:00:00Z',
            items: [],
            excludedItems: [{ sourceName: 'システム', reason: '非角色', occurrences: 2, samples: [] }],
            summary: { total: 0, editedCount: 0, glossaryEntriesAdded: 0, dismissedCount: 1 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const res = await submitChatForm('roster-zero-1', {
        items: [],
        dismissedNames: ['システム', 'SE'],
        autoContinue: false,
      });
      assert.equal(res.ok, true);
      assert.equal(res.form.summary?.dismissedCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(capturedUrl, '/api/vn/forms/roster-zero-1/submit');
    assert.deepEqual(capturedBody.items, []);
    assert.deepEqual(capturedBody.dismissedNames, ['システム', 'SE']);
    assert.equal(capturedBody.autoContinue, false);
  });

  it('parses SSE JSON safely, caps subagent task list to server limit (80), and distinguishes loopback vs default Ollama port', () => {
    assert.equal(parseSseJson('{broken'), null);
    assert.equal(parseSseJson(''), null);
    assert.deepEqual(parseSseJson('{"delta":"hi"}'), { delta: 'hi' });

    assert.equal(MAX_SUBAGENT_TASKS, 80);
    let list: Parameters<typeof upsertSubagentTaskList>[0] = [];
    for (let i = 0; i < 95; i += 1) {
      list = upsertSubagentTaskList(list, {
        taskId: `t-${i}`,
        sessionId: 's1',
        role: 'reverser',
        model: null,
        thinkingLevel: 'low',
        status: 'completed',
        activityState: 'completed',
        stage: 'done',
        startedAt: `2026-11-22T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        lastActivityAt: '2026-11-22T00:00:00Z',
        lastProgressAt: null,
        lastProgressSummary: null,
        durationMs: 10,
        toolCallCount: 0,
        errorCount: 0,
        artifactsCount: 0,
        consecutiveHypothesisFailures: 0,
        pivotWarningCount: 0,
        taskSummary: `task ${i}`,
      });
    }
    assert.equal(list.length, 80);
    assert.equal(list[0].taskId, 't-94');

    assert.equal(isDefaultLocalOllamaUrl('http://127.0.0.1:11434/v1'), true);
    assert.equal(isLoopbackHttpUrl('http://localhost:11435/v1'), true);
    assert.equal(isDefaultLocalOllamaUrl('http://localhost:11435/v1'), false);
    assert.equal(isLoopbackHttpUrl('https://api.example.com/v1'), false);
    assert.equal(isLoopbackHttpUrl('not-a-url'), false);
  });
});

describe('web/src static regression guards [WEB-P1-10, WEB-P2-07, WEB-P0-01/02/03, WEB-P1-07]', () => {
  it('contains zero undefined Tailwind color/shadow tokens and keeps topLayer.ts deleted', () => {
    assert.equal(
      fs.existsSync(path.join(WEB_SRC_DIR, 'lib', 'topLayer.ts')),
      false,
      'web/src/lib/topLayer.ts dead file must remain deleted'
    );

    const forbiddenPatterns: Array<{ name: string; re: RegExp }> = [
      { name: 'bg-stage', re: /\bbg-stage(?:\/|\b)/ },
      { name: 'bg-surface (without -raised)', re: /\bbg-surface(?![-\w])/ },
      { name: 'bg-surface-muted', re: /\bbg-surface-muted\b/ },
      { name: 'text-white', re: /\btext-white\b/ },
      { name: 'text-ink-soft', re: /\btext-ink-soft\b/ },
      { name: 'text-warn-ink', re: /\btext-warn-ink\b/ },
      { name: '--shadow-composer', re: /--shadow-composer(?:-focus)?\b/ },
      { name: 'topLayer import', re: /['"][^'"]*topLayer(?:\.[jt]s)?['"]/ },
    ];

    const files = walkFiles(WEB_SRC_DIR).filter((f) => /\.(?:ts|tsx|css)$/.test(f));
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const rel = path.relative(WEB_SRC_DIR, file).replace(/\\/g, '/');
      for (const pat of forbiddenPatterns) {
        if (pat.re.test(content)) {
          violations.push(`${rel}: matched forbidden ${pat.name}`);
        }
      }
    }

    assert.deepEqual(violations, []);
  });

  it('retains fixed state-machine invariants in SubagentTaskView.tsx and App.tsx', () => {
    const subagentSrc = fs.readFileSync(
      path.join(WEB_SRC_DIR, 'components', 'subagent', 'SubagentTaskView.tsx'),
      'utf8'
    );
    assert.equal(subagentSrc.includes('mergeOverlapText'), false);
    assert.ok(subagentSrc.includes('resolvedTaskIdRef.current !== targetId'));

    const appSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'App.tsx'), 'utf8');
    assert.equal(appSrc.includes('lastSettingsToastAtRef'), false);
    assert.equal(appSrc.includes('< 1500'), false);
    assert.equal(/<SettingsDialog[\s\S]*?busy=\{isStreaming\}/.test(appSrc), false);
    assert.equal(/<ConfirmDialog[\s\S]*?busy=\{isStreaming\}/.test(appSrc), false);
  });

  it('enforces structural, accessibility, IME and SSE contracts for CharacterRosterFormCard, MessageItem and useAgentStream', () => {
    const formCardSrc = fs.readFileSync(
      path.join(WEB_SRC_DIR, 'components', 'chat', 'CharacterRosterFormCard.tsx'),
      'utf8'
    );

    // Semantic <form> and <search> (with <search> placed outside/before <form> so Enter in filter never submits)
    const searchIdx = formCardSrc.indexOf('<search');
    const formIdx = formCardSrc.indexOf('<form');
    assert.ok(searchIdx !== -1, 'CharacterRosterFormCard must render a semantic <search> filter landmark');
    assert.ok(formIdx !== -1, 'CharacterRosterFormCard must render a semantic <form>');
    assert.ok(searchIdx < formIdx, '<search> landmark must stay outside/before <form> so Enter does not submit');
    assert.ok(/<form[\s\S]*?method="POST"/.test(formCardSrc), '<form> must declare method="POST"');
    assert.ok(/<form[\s\S]*?noValidate/.test(formCardSrc), '<form> must declare noValidate for custom inline validation');

    // Accessible inline error & live announcement attributes
    assert.ok(formCardSrc.includes('aria-invalid='), 'CharacterRosterFormCard inputs must bind aria-invalid');
    assert.ok(formCardSrc.includes('aria-describedby='), 'CharacterRosterFormCard inputs must bind aria-describedby');
    assert.ok(formCardSrc.includes('aria-live="polite"'), 'CharacterRosterFormCard must expose a polite status live region');
    assert.ok(formCardSrc.includes('role="alert"'), 'CharacterRosterFormCard must render submit errors with role="alert"');

    // CJK IME composition guard on Enter
    assert.ok(
      formCardSrc.includes('isComposing') && formCardSrc.includes('229'),
      'CharacterRosterFormCard must guard Enter keydown against CJK IME composition (isComposing / keyCode 229)'
    );

    // Every <button> must declare an explicit type attribute (prevent accidental form submission by non-submit controls)
    const buttonTags = Array.from(formCardSrc.matchAll(/<button\b([\s\S]*?)>/g)).map((m) => m[1]);
    assert.ok(buttonTags.length >= 6, `Expected multiple buttons in CharacterRosterFormCard, found ${buttonTags.length}`);
    let submitButtonCount = 0;
    for (const attrs of buttonTags) {
      const typeMatch = /\btype="(button|submit)"/.exec(attrs);
      assert.ok(
        typeMatch !== null,
        `Every <button> in CharacterRosterFormCard must explicitly specify type="button" or type="submit", found: <button${attrs}>`
      );
      if (typeMatch[1] === 'submit') submitButtonCount += 1;
    }
    assert.equal(submitButtonCount, 1, 'Exactly one primary submit button should have type="submit"');

    // SSE listener & sync_state hydration in useAgentStream.ts
    const streamSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'hooks', 'useAgentStream.ts'), 'utf8');
    assert.ok(
      streamSrc.includes("addEventListener('chat_form_updated'"),
      'useAgentStream must subscribe to chat_form_updated SSE events'
    );
    assert.ok(
      streamSrc.includes('Array.isArray(data.chatForms)'),
      'useAgentStream must hydrate chatForms from sync_state SSE events'
    );

    // MessageItem.tsx linkage to CharacterRosterFormCard via details.chatFormId
    const msgItemSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'MessageItem.tsx'), 'utf8');
    assert.ok(msgItemSrc.includes('CharacterRosterFormCard'), 'MessageItem must render CharacterRosterFormCard');
    assert.ok(
      msgItemSrc.includes('details?.chatFormId') && msgItemSrc.includes('chatForms?.[formId]'),
      'MessageItem must link tool result chatFormId to live chatForms state'
    );

    // CharacterRosterFormCard.tsx & api.ts dismissedNames / excludedItems / 0-character confirm / one-click restore contracts
    assert.ok(
      formCardSrc.includes('form.excludedItems') && formCardSrc.includes('excludedRows'),
      'CharacterRosterFormCard must hydrate and manage form.excludedItems'
    );
    assert.ok(
      formCardSrc.includes('handleDismissOrRemoveRow') && formCardSrc.includes('handleRestoreExcluded'),
      'CharacterRosterFormCard must support dismissing rows into excluded list and one-click restoring them'
    );
    assert.ok(
      formCardSrc.includes('恢复为角色'),
      'CharacterRosterFormCard must expose a one-click "恢复为角色" restore action for excluded items'
    );
    assert.ok(
      formCardSrc.includes('rows.length === 0 && excludedRows.length === 0') &&
        formCardSrc.includes('确认无出场角色'),
      'CharacterRosterFormCard must allow 0-character confirmation when excludedRows is non-empty'
    );
    assert.ok(
      formCardSrc.includes('dismissedNames'),
      'CharacterRosterFormCard must forward dismissedNames in submit payload'
    );

    const apiSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'lib', 'api.ts'), 'utf8');
    assert.ok(
      apiSrc.includes('export interface ChatFormExcludedItem') &&
        apiSrc.includes('excludedItems?: ChatFormExcludedItem[]') &&
        apiSrc.includes('dismissedCount?: number') &&
        apiSrc.includes('dismissedNames?: string[]'),
      'web/src/lib/api.ts must type ChatFormExcludedItem, excludedItems, dismissedCount, and dismissedNames'
    );
  });
});

describe('Three-layer compaction frontend contracts — slash parser, divider dedup & minimalist UI invariants', () => {
  it('parses /compact slash commands strictly with positive and negative boundary parity', () => {
    // Positive cases
    assert.deepEqual(parseSlashCompactCommand('/compact'), { isCompact: true });
    assert.deepEqual(parseSlashCompactCommand('  /compact   '), { isCompact: true });
    assert.deepEqual(parseSlashCompactCommand('/COMPACT'), { isCompact: true });
    assert.deepEqual(parseSlashCompactCommand('/compact focus on character roster'), {
      isCompact: true,
      focus: 'focus on character roster',
    });
    assert.deepEqual(parseSlashCompactCommand('  /Compact   保留角色译名与 QA 失败原因  '), {
      isCompact: true,
      focus: '保留角色译名与 QA 失败原因',
    });
    assert.deepEqual(parseSlashCompactCommand('/compact line1\nline2'), {
      isCompact: true,
      focus: 'line1\nline2',
    });

    // Negative boundary cases (must NOT match prefix lookalikes or mid-sentence text)
    for (const nonCompact of [
      '',
      '   ',
      '/compaction',
      '/compactify',
      '/compact-now',
      '/compact:focus',
      'please run /compact',
      'text /compact focus',
      'compact',
    ]) {
      assert.equal(
        parseSlashCompactCommand(nonCompact),
        null,
        `parseSlashCompactCommand must return null for: ${JSON.stringify(nonCompact)}`
      );
    }
  });

  it('deduplicates compaction divider messages by id while preserving message order and metadata', () => {
    const existing: ChatMessage[] = [
      { id: 'u1', role: 'user', content: '先解包 data.xp3', timestamp: '10:00:00' },
      { id: 'a1', role: 'assistant', content: '已完成解包。', timestamp: '10:00:05' },
    ];

    const summaryInfo = {
      id: 'cmp-entry-001',
      timestamp: '2026-11-23T12:00:00.000Z',
      reason: 'manual' as const,
      tokensBefore: 142_000,
      tokensAfter: 21_500,
      summary: '## Goal\nKeep locked roster and QA blockers.',
      focus: 'character roster',
      checkpointPath: '.papercup/tmp/diagnostics/compactions/2026-11-23-main-cmp1.md',
    };

    const appended = appendCompactionMessageIfMissing(existing, summaryInfo);
    assert.equal(appended.length, 3);
    assert.deepEqual(
      appended.map((m) => m.id),
      ['u1', 'a1', 'cmp-entry-001']
    );
    const divider = appended[2];
    assert.equal(divider.role, 'compaction');
    assert.equal(divider.content, summaryInfo.summary);
    assert.deepEqual(divider.compaction, {
      reason: 'manual',
      tokensBefore: 142_000,
      tokensAfter: 21_500,
      focus: 'character roster',
      checkpointPath: '.papercup/tmp/diagnostics/compactions/2026-11-23-main-cmp1.md',
    });

    // Re-applying same id (e.g. SSE compaction_end followed by sync/reload) MUST be a no-op
    const deduped = appendCompactionMessageIfMissing(appended, summaryInfo);
    assert.equal(deduped, appended, 'Duplicate compaction id must return original array reference without duplication');
    assert.equal(deduped.length, 3);

    // Distinct second compaction appends cleanly at tail
    const second = appendCompactionMessageIfMissing(deduped, {
      ...summaryInfo,
      id: 'cmp-entry-002',
      reason: 'threshold',
      focus: undefined,
      checkpointPath: undefined,
    });
    assert.deepEqual(
      second.map((m) => m.id),
      ['u1', 'a1', 'cmp-entry-001', 'cmp-entry-002']
    );
    assert.equal(second[3].compaction?.reason, 'threshold');
    assert.equal(second[3].compaction?.focus, undefined);
    assert.equal(second[3].compaction?.checkpointPath, undefined);

    // Empty/missing id is safely ignored
    const ignored = appendCompactionMessageIfMissing(second, { ...summaryInfo, id: '' });
    assert.equal(ignored, second);

    // Formatter & reason badge helpers
    const converted = toCompactionChatMessage(summaryInfo);
    assert.equal(converted.id, 'cmp-entry-001');
    assert.equal(formatCompactionTokens(142_000), '142K');
    assert.equal(formatCompactionTokens(21_500), '21.5K');
    assert.equal(formatCompactionTokens(512), '512');
    assert.equal(getCompactionReasonMeta('manual').label, '手动');
    assert.equal(getCompactionReasonMeta('threshold').label, '自动阈值');
    assert.equal(getCompactionReasonMeta('overflow').label, '溢出恢复');
  });

  it('sends expected REST payloads for compactSession and compactSubagent', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [];

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: JSON.parse(String(init?.body || '{}')),
      });
      if (String(input).includes('/subagents/')) {
        return new Response(
          JSON.stringify({ ok: true, status: 'queued', taskId: 'rev-1', focus: 'keep binary offsets' }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ ok: true, status: 'noop', message: '当前对话较短，暂无可压缩的上下文。' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const mainNoFocus = await compactSession('   ');
      assert.equal(mainNoFocus.status, 'noop');
      await compactSession('  focus roster  ');
      const subRes = await compactSubagent('rev-1', ' keep binary offsets ');
      assert.equal(subRes.status, 'queued');
      assert.equal(subRes.taskId, 'rev-1');
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(calls[0].url, '/api/session/compact');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, {});
    assert.equal(calls[1].url, '/api/session/compact');
    assert.deepEqual(calls[1].body, { focus: 'focus roster' });
    assert.equal(calls[2].url, '/api/subagents/rev-1/compact');
    assert.equal(calls[2].method, 'POST');
    assert.deepEqual(calls[2].body, { focus: 'keep binary offsets' });
  });

  it('enforces minimalist UI contract: no explicit Compact button, /compact interception in Composer & SubagentTaskView, CompactionDividerCard in MessageItem', () => {
    const composerSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'Composer.tsx'), 'utf8');
    const subagentSrc = fs.readFileSync(
      path.join(WEB_SRC_DIR, 'components', 'subagent', 'SubagentTaskView.tsx'),
      'utf8'
    );
    const msgItemSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'MessageItem.tsx'), 'utf8');
    const streamSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'hooks', 'useAgentStream.ts'), 'utf8');

    // 1. Minimalist UI invariant: NEVER render an explicit manual Compact button in Composer or SubagentTaskView
    for (const [label, src] of [
      ['Composer.tsx', composerSrc],
      ['SubagentTaskView.tsx', subagentSrc],
    ] as const) {
      const buttonBlocks = Array.from(src.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((m) => m[0]);
      assert.ok(buttonBlocks.length > 0, `Expected buttons in ${label}`);
      for (const btn of buttonBlocks) {
        assert.equal(
          /\bonCompact\b|\bhandleCompactSubagent\b|\bcompactSession\b|\bcompactSubagent\b|压缩上下文|\/compact/i.test(
            btn
          ),
          false,
          `${label} must NOT render an explicit manual Compact button; found: ${btn.slice(0, 200)}`
        );
      }
    }

    // 2. /compact slash interception MUST be wired in BOTH Composer.tsx (idle + streaming) and SubagentTaskView.tsx (idle + running)
    const composerCompactMatches = composerSrc.match(/parseSlashCompactCommand\(/g) ?? [];
    assert.ok(
      composerCompactMatches.length >= 2,
      `Composer.tsx must intercept /compact in both idle submit and streaming queue submit, found ${composerCompactMatches.length} call(s)`
    );
    const subagentCompactMatches = subagentSrc.match(/parseSlashCompactCommand\(/g) ?? [];
    assert.ok(
      subagentCompactMatches.length >= 2,
      `SubagentTaskView.tsx must intercept /compact in both idle send and running queue send, found ${subagentCompactMatches.length} call(s)`
    );

    // 3. MessageItem.tsx wires CompactionDividerCard for role === 'compaction'
    assert.ok(
      msgItemSrc.includes("message.role === 'compaction'") && msgItemSrc.includes('<CompactionDividerCard'),
      'MessageItem.tsx must render CompactionDividerCard when message.role === "compaction"'
    );

    // 4. useAgentStream.ts subscribes to compaction SSE events and avoids phantom fallback message after turn_segment_commit
    assert.ok(streamSrc.includes("addEventListener('compaction_start'"));
    assert.ok(streamSrc.includes("addEventListener('compaction_end'"));
    assert.ok(streamSrc.includes("addEventListener('compaction_queued'"));
    assert.ok(streamSrc.includes('appendCompactionMessageIfMissing'));
    assert.ok(streamSrc.includes('shouldSkipEmptyTurnFinish'));

    // 5. Verify compaction UI clarity contracts:
    //    - api.ts exposes triggerTokens?: number on both SubagentTaskSummary & SessionTokenUsageSnapshot contextUsage
    //    - SubagentTaskView.tsx renders triggerTokens compaction threshold when < contextWindow and deduplicates active compaction notices to ONLY 2 places (top header pill + above-input strip)
    //    - Composer.tsx renders 自动压缩触发线 when triggerTokens < contextWindow
    const apiSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'lib', 'api.ts'), 'utf8');
    const triggerFieldMatches = apiSrc.match(/triggerTokens\?:\s*number/g) ?? [];
    assert.ok(
      triggerFieldMatches.length >= 2,
      `web/src/lib/api.ts must declare triggerTokens?: number on both SubagentTaskSummary and SessionTokenUsageSnapshot contextUsage, found ${triggerFieldMatches.length}`
    );

    assert.ok(
      subagentSrc.includes('triggerTokens < contextWindow') &&
        subagentSrc.includes('自动压缩触发线') &&
        subagentSrc.includes('· 窗口'),
      'SubagentTaskView.tsx must display triggerTokens compaction threshold cleanly when triggerTokens < contextWindow'
    );
    const subagentCompactingNoticeCount = (subagentSrc.match(/正在压缩上下文…/g) ?? []).length;
    assert.equal(
      subagentCompactingNoticeCount,
      2,
      `SubagentTaskView.tsx must render 正在压缩上下文… in ONLY 2 places (top header statusMeta pill + above-input strip), found ${subagentCompactingNoticeCount}`
    );
    assert.ok(
      subagentSrc.includes('isCurrentRunning && !isSubagentCompacting && idx === streamingAssistantIdx'),
      'SubagentTaskView.tsx must pause last-message streaming status indicator while compacting to avoid duplicate pill'
    );
    assert.ok(
      subagentSrc.includes("t.activityState === 'compacting' ? '压缩中'"),
      'SubagentTaskView.tsx task selector must use concise 压缩中 label instead of repeating 正在压缩上下文…'
    );

    assert.ok(
      composerSrc.includes('tokenUsage.contextUsage.triggerTokens < tokenUsage.contextUsage.contextWindow') &&
        composerSrc.includes('<span>自动压缩触发线</span>'),
      'Composer.tsx must display 自动压缩触发线 in token popover when triggerTokens < contextWindow'
    );

    // 6. Verify shouldSkipEmptyTurnFinish suppresses phantom '已完成任务。' after post-turn compaction commit, while preserving normal/aborted endings
    assert.equal(
      shouldSkipEmptyTurnFinish({
        aborted: false,
        hadCommittedSegment: true,
        thinking: '',
        response: '',
        toolsCount: 0,
      }),
      true
    );
    assert.equal(
      shouldSkipEmptyTurnFinish({
        aborted: false,
        hadCommittedSegment: false,
        thinking: '',
        response: '',
        toolsCount: 0,
      }),
      false
    );
    assert.equal(
      shouldSkipEmptyTurnFinish({
        aborted: true,
        hadCommittedSegment: true,
        thinking: '',
        response: '',
        toolsCount: 0,
      }),
      false
    );
    assert.equal(
      shouldSkipEmptyTurnFinish({
        aborted: false,
        hadCommittedSegment: true,
        thinking: '',
        response: 'follow-up answer',
        toolsCount: 0,
      }),
      false
    );
  });
});

describe('Translator streaming progress & minimalist UI invariants [SubagentTaskView, ToolCallBlock, useAgentStream]', () => {
  it('updates translator isThinking and lastProgressSummary cleanly through upsertSubagentTaskList without duplicating entries', () => {
    const base = {
      taskId: 'subtask-translator-1',
      sessionId: 'sess-1',
      role: 'translator',
      model: 'magpie/gpt-5-compat',
      thinkingLevel: 'off',
      status: 'running' as const,
      activityState: 'waiting_model' as const,
      stage: 'translate',
      startedAt: '2026-11-24T15:00:00.000Z',
      lastActivityAt: '2026-11-24T15:00:00.000Z',
      lastProgressAt: null,
      lastProgressSummary: null as string | null,
      durationMs: 100,
      toolCallCount: 0,
      errorCount: 0,
      artifactsCount: 0,
      consecutiveHypothesisFailures: 0,
      pivotWarningCount: 0,
      interactive: false,
      isThinking: false,
      taskSummary: '[translator batch prompt: 120 chars]',
    };

    let list = upsertSubagentTaskList([], base);
    assert.equal(list.length, 1);
    assert.equal(list[0].isThinking, false);
    assert.equal(list[0].lastProgressSummary, null);

    list = upsertSubagentTaskList(list, {
      ...base,
      isThinking: true,
      lastProgressAt: '2026-11-24T15:00:01.000Z',
      lastProgressSummary: 'batch_007 · 思考中（已生成 42 字符）',
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].isThinking, true);
    assert.equal(list[0].lastProgressSummary, 'batch_007 · 思考中（已生成 42 字符）');

    list = upsertSubagentTaskList(list, {
      ...base,
      isThinking: false,
      lastProgressAt: '2026-11-24T15:00:02.000Z',
      lastProgressSummary: 'batch_007 · 生成译文中（已译 2/3 行 · 55 字符）',
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].isThinking, false);
    assert.equal(list[0].lastProgressSummary, 'batch_007 · 生成译文中（已译 2/3 行 · 55 字符）');

    list = upsertSubagentTaskList(list, {
      ...base,
      status: 'completed',
      activityState: 'completed',
      isThinking: false,
      lastProgressAt: '2026-11-24T15:00:03.000Z',
      lastProgressSummary: 'batch_007 · 已返回译文（3/3 行 · 90 字符 · 思考 42 字）',
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'completed');
    assert.equal(list[0].isThinking, false);
    assert.equal(list[0].lastProgressSummary, 'batch_007 · 已返回译文（3/3 行 · 90 字符 · 思考 42 字）');
  });

  it('verifies SubagentTaskView.tsx and ToolCallBlock.tsx surface translator live lastProgressSummary & isThinking while preserving minimalist invariants', () => {
    const subagentSrc = fs.readFileSync(
      path.join(WEB_SRC_DIR, 'components', 'subagent', 'SubagentTaskView.tsx'),
      'utf8'
    );
    const toolBlockSrc = fs.readFileSync(
      path.join(WEB_SRC_DIR, 'components', 'chat', 'ToolCallBlock.tsx'),
      'utf8'
    );
    const apiSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'lib', 'api.ts'), 'utf8');

    // 1. api.ts declares lastProgressSummary & isThinking on SubagentTaskSummary
    assert.ok(apiSrc.includes('lastProgressSummary: string | null;'));
    assert.ok(apiSrc.includes('isThinking?: boolean;'));

    // 2. SubagentTaskView.tsx surfaces translator live lastProgressSummary & isThinking
    assert.ok(
      subagentSrc.includes('function statusMeta') &&
        subagentSrc.includes("isThinking\n          ? '思考中'") &&
        subagentSrc.includes('activeSummary?.isThinking') &&
        subagentSrc.includes('activeSummary?.lastProgressSummary'),
      'SubagentTaskView.tsx must wire isThinking and lastProgressSummary into statusMeta and refresh effect'
    );
    assert.ok(
      subagentSrc.includes('isCurrentThinking = Boolean(activeSummary?.isThinking ?? currentSnap?.isThinking)') &&
        subagentSrc.includes('liveProgressSummary = activeSummary?.lastProgressSummary ?? currentSnap?.lastProgressSummary ?? null'),
      'SubagentTaskView.tsx must derive live isCurrentThinking and liveProgressSummary'
    );
    assert.ok(
      subagentSrc.includes('resolvedTaskId && isTranslator && (currentSnap || activeSummary)') &&
        subagentSrc.includes('(isCurrentRunning || liveProgressSummary)') &&
        subagentSrc.includes("liveProgressSummary || (isCurrentThinking ? '模型思考中…' : '等待模型返回译文流…')"),
      'SubagentTaskView.tsx must render liveProgressSummary & isCurrentThinking in the translator lightweight progress card'
    );

    // 3. Minimalist invariants preserved in SubagentTaskView.tsx:
    //    - 正在压缩上下文… in ONLY 2 places
    //    - No explicit Compact button
    //    - No raw translator chat transcript or composer
    const compactNoticeCount = (subagentSrc.match(/正在压缩上下文…/g) ?? []).length;
    assert.equal(compactNoticeCount, 2, `Expected 正在压缩上下文… in ONLY 2 places, found ${compactNoticeCount}`);
    const buttonBlocks = Array.from(subagentSrc.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((m) => m[0]);
    for (const btn of buttonBlocks) {
      assert.equal(
        /\bonCompact\b|\bhandleCompactSubagent\b|\bcompactSubagent\b|压缩上下文|\/compact/i.test(btn),
        false,
        `SubagentTaskView.tsx must NOT render an explicit manual Compact button; found: ${btn.slice(0, 160)}`
      );
    }
    assert.ok(
      subagentSrc.includes("currentSnap && currentSnap.interactive !== false && currentSnap.role !== 'translator'") &&
        subagentSrc.includes('resolvedTaskId && !isTranslator') &&
        subagentSrc.includes('不保存逐条对话全文'),
      'SubagentTaskView.tsx must keep raw chat transcript & composer disabled for translator tasks'
    );

    // 4. ToolCallBlock.tsx surfaces translator lastProgressSummary & isThinking
    assert.ok(
      toolBlockSrc.includes("if (task.activityState === 'waiting_model')") &&
        toolBlockSrc.includes("if (task.isThinking) return '思考中';") &&
        toolBlockSrc.includes("if (task.lastProgressSummary) return '生成中';") &&
        toolBlockSrc.includes("return '等待模型';"),
      'ToolCallBlock.tsx describeSubagentActivity must distinguish 思考中 / 生成中 / 等待模型'
    );
    assert.ok(
      toolBlockSrc.includes("linkedSubagentTask.role === 'translator' && linkedSubagentTask.lastProgressSummary") &&
        toolBlockSrc.includes('describeSubagentActivity(linkedSubagentTask)'),
      'ToolCallBlock.tsx must surface translator lastProgressSummary directly and fall back to describeSubagentActivity'
    );
  });
});

describe('Chat image attachments helper & multimodal UI contracts [imageAttachments, Composer, MessageItem, PendingQueueTray, ImageAttachmentStrip, ImageLightbox, SubagentTaskView]', () => {
  it('validates supported image MIME types, decoded base64 byte estimation & safe data URL serialization', () => {
    // isSupportedImageMimeType
    assert.equal(isSupportedImageMimeType('image/png'), true);
    assert.equal(isSupportedImageMimeType('image/jpeg'), true);
    assert.equal(isSupportedImageMimeType('image/gif'), true);
    assert.equal(isSupportedImageMimeType('image/webp'), true);
    assert.equal(isSupportedImageMimeType('IMAGE/PNG; charset=utf-8'), true);

    assert.equal(isSupportedImageMimeType('image/svg+xml'), false);
    assert.equal(isSupportedImageMimeType('text/html'), false);
    assert.equal(isSupportedImageMimeType('image/bmp'), false);
    assert.equal(isSupportedImageMimeType(''), false);
    assert.equal(isSupportedImageMimeType(null), false);
    assert.equal(isSupportedImageMimeType(undefined), false);
    assert.equal(isSupportedImageMimeType(42), false);

    // estimateDecodedBase64Bytes
    assert.equal(estimateDecodedBase64Bytes(''), 0);
    assert.equal(estimateDecodedBase64Bytes('AAAA'), 3);
    assert.equal(estimateDecodedBase64Bytes('AAA='), 2);
    assert.equal(estimateDecodedBase64Bytes('AA=='), 1);
    assert.equal(estimateDecodedBase64Bytes(Buffer.from('hello world').toString('base64')), 11);

    // toImageDataUrl
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const jpegB64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');
    const gifB64 = Buffer.from('GIF89a', 'ascii').toString('base64');
    const webpB64 = Buffer.from('RIFF1234WEBP', 'ascii').toString('base64');

    assert.equal(toImageDataUrl({ mimeType: 'image/png', data: pngB64 }), `data:image/png;base64,${pngB64}`);
    assert.equal(
      toImageDataUrl({ mimeType: 'image/jpeg', data: `${jpegB64.slice(0, 4)}\n${jpegB64.slice(4)}` }),
      `data:image/jpeg;base64,${jpegB64}`
    );
    assert.equal(toImageDataUrl({ mimeType: 'image/gif', data: gifB64 }), `data:image/gif;base64,${gifB64}`);
    assert.equal(toImageDataUrl({ mimeType: 'image/webp', data: webpB64 }), `data:image/webp;base64,${webpB64}`);

    // Rejects unsafe / unsupported MIME or invalid / empty base64
    assert.equal(toImageDataUrl({ mimeType: 'image/svg+xml' as any, data: pngB64 }), null);
    assert.equal(toImageDataUrl({ mimeType: 'text/html' as any, data: pngB64 }), null);
    assert.equal(toImageDataUrl({ mimeType: 'image/png', data: 'not-valid-base64!' }), null);
    assert.equal(toImageDataUrl({ mimeType: 'image/png', data: 'abc' }), null);
    assert.equal(toImageDataUrl({ mimeType: 'image/png', data: '' }), null);
    assert.equal(toImageDataUrl({ mimeType: 'image/png', data: '   ' }), null);
    assert.equal(toImageDataUrl(null), null);
    assert.equal(toImageDataUrl(undefined), null);
  });

  it('preserves image upload/paste/drop, lightbox preview, imageCount pill & modelSupportsImage guard across chat & subagent components', () => {
    const composerSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'Composer.tsx'), 'utf8');
    const messageItemSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'MessageItem.tsx'), 'utf8');
    const queueTraySrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'PendingQueueTray.tsx'), 'utf8');
    const stripSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'ImageAttachmentStrip.tsx'), 'utf8');
    const lightboxSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'chat', 'ImageLightbox.tsx'), 'utf8');
    const subagentSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'components', 'subagent', 'SubagentTaskView.tsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(WEB_SRC_DIR, 'App.tsx'), 'utf8');

    // 1. Composer.tsx: file input upload, clipboard paste, drag-drop & modelSupportsImage guard
    assert.ok(
      composerSrc.includes('type="file"') &&
        composerSrc.includes('accept="image/png,image/jpeg,image/webp,image/gif"') &&
        composerSrc.includes('onPaste={handlePaste}') &&
        composerSrc.includes('onDrop={handleDrop}') &&
        composerSrc.includes('extractClipboardImageFiles') &&
        composerSrc.includes('readImageFilesToAttachments'),
      'Composer.tsx must wire image file upload, clipboard paste, and drag-and-drop'
    );
    assert.ok(
      composerSrc.includes('const modelBlocksImages = images.length > 0 && selectedOption?.supportsImage === false;') &&
        composerSrc.includes('!modelBlocksImages') &&
        composerSrc.includes('modelSupportsImage={selectedOption?.supportsImage}'),
      'Composer.tsx must enforce modelSupportsImage guard on send/queue and pass modelSupportsImage to ImageAttachmentStrip'
    );

    // 2. MessageItem.tsx: renders persisted user images and opens ImageLightbox on click
    assert.ok(
      messageItemSrc.includes('const userImages = Array.isArray(message.images) ? message.images : [];') &&
        messageItemSrc.includes('toImageDataUrl(img)') &&
        messageItemSrc.includes('setPreviewImageIdx(idx)') &&
        messageItemSrc.includes('<ImageLightbox'),
      'MessageItem.tsx must render user message image thumbnails with ImageLightbox preview'
    );

    // 3. PendingQueueTray.tsx: displays imageCount pill without base64 bloat
    assert.ok(
      queueTraySrc.includes('item.imageCount && item.imageCount > 0') &&
        queueTraySrc.includes('附带 ${item.imageCount} 张图片') &&
        queueTraySrc.includes('<span>{item.imageCount}</span>'),
      'PendingQueueTray.tsx must render imageCount pill for queued multimodal items'
    );

    // 4. ImageAttachmentStrip.tsx & ImageLightbox.tsx: preview lightbox, remove button, vision warning alert
    assert.ok(
      stripSrc.includes('setPreviewIndex(idx)') &&
        stripSrc.includes('onRemove(idx)') &&
        stripSrc.includes('modelSupportsImage === false') &&
        stripSrc.includes('role="alert"') &&
        stripSrc.includes('<ImageLightbox'),
      'ImageAttachmentStrip.tsx must provide thumbnail preview, removal, vision warning alert, and ImageLightbox'
    );
    assert.ok(
      lightboxSrc.includes('toImageDataUrl(current)') &&
        lightboxSrc.includes("e.key === 'ArrowLeft'") &&
        lightboxSrc.includes("e.key === 'ArrowRight'") &&
        lightboxSrc.includes('onChangeIndex(null)'),
      'ImageLightbox.tsx must validate data URL via toImageDataUrl and support keyboard prev/next navigation'
    );

    // 5. SubagentTaskView.tsx & App.tsx: upload/paste/drop & modelSupportsImage guard
    assert.ok(
      subagentSrc.includes('modelSupportsImage?: boolean;') &&
        subagentSrc.includes('const modelBlocksImages = images.length > 0 && modelSupportsImage === false;') &&
        subagentSrc.includes('!modelBlocksImages') &&
        subagentSrc.includes('modelSupportsImage={modelSupportsImage}') &&
        subagentSrc.includes('type="file"') &&
        subagentSrc.includes('accept="image/png,image/jpeg,image/webp,image/gif"') &&
        subagentSrc.includes('onPaste={handlePaste}') &&
        subagentSrc.includes('onDrop={handleDrop}'),
      'SubagentTaskView.tsx must preserve image upload/paste/drop and modelSupportsImage guard'
    );
    assert.ok(
      appSrc.includes('modelSupportsImage={models.find((m) => m.key === (selectedModel || models[0]?.key))?.supportsImage}'),
      'App.tsx must pass active model supportsImage down to SubagentTaskView'
    );
  });
});
