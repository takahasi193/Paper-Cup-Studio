import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@sinclair/typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { config } from '../config.js';
import { readVnResearchConfig } from '../security/guarded-tools.js';
import { isPathInsideWorkspace, isRestrictedSecretPath, redactSecrets } from '../security/secrets.js';
import { resolveBuiltinReverserSkillDir } from '../subagents/roles.js';
import { patchWorkspaceFont } from '../vn/core.js';
import { isSymlinkPath, realpathSafe } from '../vn/profile.js';
import { prepareReadOnlyTraceSandbox } from '../vn/smoke.js';

const execFileAsync = promisify(execFile);

const MAX_FETCH_BYTES = 64 * 1024;
const MAX_SEARCH_JSON_BYTES = 512 * 1024;
const MAX_TREE_JSON_BYTES = 4 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 12_000;
const INSPECT_TIMEOUT_MS = 30_000;
const DEFAULT_TRACE_TIMEOUT_SEC = 20;
const MIN_TRACE_TIMEOUT_SEC = 5;
const MAX_TRACE_TIMEOUT_SEC = 45;

export interface CuratedReRepoEntry {
  repo: string;
  description: string;
  tags: string[];
}

export const CURATED_VN_RE_REPOS: readonly CuratedReRepoEntry[] = Object.freeze([
  {
    repo: 'morkt/GARbro',
    description: 'Visual Novel archive/image/audio extraction library (Arc*, Image*, Siglus, BGI, Artemis, YU-RIS, Majiro, QLIE, etc.)',
    tags: ['garbro', 'siglus', 'reallive', 'artemis', 'bgi', 'majiro', 'yuris', 'qlie', 'archive', 'lzss'],
  },
  {
    repo: 'crskycode/GARbro',
    description: 'Community fork of GARbro with extended modern VN archive/codec implementations',
    tags: ['garbro', 'siglus', 'artemis', 'bgi', 'archive', 'unpack'],
  },
  {
    repo: 'arcusmaximus/VNTranslationTools',
    description: 'C# visual-novel script/archive extraction & insertion tools (Siglus, RealLive, Softpal, Escude, etc.)',
    tags: ['siglus', 'reallive', 'softpal', 'escude', 'scene.pck', 'gameexe', 'translation'],
  },
  {
    repo: 'regomne/chinesize',
    description: 'Galgame localization patches, unpackers/repackers & Win32 hook implementations across Japanese VN engines',
    tags: ['siglus', 'bgi', 'majiro', 'cmvs', 'hook', 'gbk', 'patch'],
  },
  {
    repo: 'Dir-A/Dir-A_Essays_MD',
    description: 'Galgame reverse-engineering methodology essays (API breakpoints, hardware watchpoints, archive triage)',
    tags: ['methodology', 'x64dbg', 'ida', 'readfile', 'createfile', 'lzss', 'xor'],
  },
  {
    repo: 'Dir-A/ReVN',
    description: 'C++ Visual Novel unpackers, repackers, script text editors & VFS hooks (GSD, ISM, PJADV, Valkyria)',
    tags: ['revn', 'gsd', 'ism', 'pjadv', 'valkyria', 'vfs', 'hook', 'repack', 'script'],
  },
  {
    repo: 'YuriSizuku/GalgameReverse',
    description: 'Galgame localization & reverse-engineering scripts, hooks, font builders, and engine analyzers (MAJIROv3, AZsystem, krkrz/hxv4, etc.)',
    tags: ['galgame', 'majiro', 'azsystem', 'krkr', 'krkrz', 'hxv4', 'font', 'hook', 'gbk', 'sjis'],
  },
]);

export const RE_LOOKUP_ALLOWED_HOSTS = new Set([
  'api.github.com',
  'raw.githubusercontent.com',
  'github.com',
  'gist.githubusercontent.com',
  'www.cnblogs.com',
  'cnblogs.com',
  'blog.schnee.moe',
  'zenn.dev',
  'qiita.com',
]);

const RE_LOOKUP_CONSTRAINT_FOOTER =
  '\n[参考约束] 以上为公开参考资料，严禁直接当作已确认结论；请记为 recalled-unverified 并立即用本工作区实际字节 oracle 验证。';

export interface ReverserToolOptions {
  getKnownSecrets?: () => Iterable<string>;
  fetchImpl?: typeof fetch;
  pythonPath?: string;
}

export function validateLookupUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl ?? '').trim());
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Only https:// URLs are allowed (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are prohibited');
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new Error('URL hostname is missing');
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    net.isIP(host) !== 0 ||
    net.isIP(host.replace(/^\[|\]$/g, '')) !== 0
  ) {
    throw new Error(`Private/loopback/IP hostnames are prohibited: ${host}`);
  }
  if (!RE_LOOKUP_ALLOWED_HOSTS.has(host)) {
    throw new Error(`Host "${host}" is not in the vn_re_lookup allowlist`);
  }
  return parsed;
}

function resolveWorkspaceTargetFile(workspace: string, rawPath: string): { absPath: string; relPath: string } {
  const ws = realpathSafe(workspace);
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) {
    throw new Error('path is required');
  }
  if (isRestrictedSecretPath(trimmed, ws)) {
    throw new Error(`Security guard: accessing restricted path "${rawPath}" is prohibited.`);
  }
  const absCandidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(ws, trimmed);
  if (!isPathInsideWorkspace(absCandidate, ws)) {
    throw new Error(`Security guard: path "${rawPath}" is outside active workspace.`);
  }
  if (isSymlinkPath(absCandidate)) {
    throw new Error(`Security guard: symlink path "${rawPath}" is prohibited.`);
  }
  if (!fs.existsSync(absCandidate) || !fs.statSync(absCandidate).isFile()) {
    throw new Error(`Target file not found: ${rawPath}`);
  }
  const realTarget = realpathSafe(absCandidate);
  if (!isPathInsideWorkspace(realTarget, ws) || isRestrictedSecretPath(realTarget, ws)) {
    throw new Error(`Security guard: resolved path "${rawPath}" escapes workspace or is restricted.`);
  }
  const relPath = path.relative(ws, realTarget).replace(/\\/g, '/');
  return { absPath: realTarget, relPath };
}

function resolveReScriptPath(scriptName: 're_inspect.py' | 're_trace.py'): string {
  const skillDir = resolveBuiltinReverserSkillDir();
  if (skillDir) {
    const candidate = path.join(skillDir, 'scripts', scriptName);
    if (fs.existsSync(candidate)) return candidate;
  }
  const fallback = path.resolve(process.cwd(), 'src/subagents/vn-reverser/scripts', scriptName);
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(`Helper script not found: ${scriptName}`);
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:p|div|li|br|tr|h[1-6]|pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchBoundedText(
  url: string,
  fetchFn: typeof fetch,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
  maxBytes: number = MAX_FETCH_BYTES
): Promise<{ status: number; contentType: string; text: string }> {
  const validated = validateLookupUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const reqHeaders: Record<string, string> = {
      'User-Agent': 'PaperCup-Reverser-Lookup/1.0',
      ...headers,
    };
    if (validated.hostname === 'api.github.com' && process.env.GITHUB_TOKEN?.trim()) {
      reqHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN.trim()}`;
    }
    const res = await fetchFn(validated.toString(), {
      method: 'GET',
      headers: reqHeaders,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} redirect without location`);
      const nextUrl = new URL(loc, validated).toString();
      validateLookupUrl(nextUrl);
      const res2 = await fetchFn(nextUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'PaperCup-Reverser-Lookup/1.0' },
        redirect: 'error',
        signal: controller.signal,
      });
      return await readResponseUpToLimit(res2, maxBytes);
    }
    return await readResponseUpToLimit(res, maxBytes);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function readResponseUpToLimit(
  res: Response,
  maxBytes: number = MAX_FETCH_BYTES
): Promise<{ status: number; contentType: string; text: string }> {
  const contentType = res.headers.get('content-type') || '';
  const limit = Math.max(1024, Math.floor(maxBytes));
  if (!res.body) {
    const raw = await res.text();
    return { status: res.status, contentType, text: raw.slice(0, limit) };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      const room = limit - total;
      if (room <= 0) break;
      const slice = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (total >= limit) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
    }
  }
  const buf = Buffer.concat(chunks);
  return { status: res.status, contentType, text: buf.toString('utf8') };
}

function sliceLines(text: string, startLine = 1, maxLines = 140): { sliced: string; totalLines: number; start: number; end: number } {
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Math.floor(startLine || 1));
  const limit = Math.max(10, Math.min(250, Math.floor(maxLines || 140)));
  const slice = lines.slice(start - 1, start - 1 + limit);
  const numbered = slice.map((ln, idx) => `${start + idx}: ${ln}`).join('\n');
  return {
    sliced: numbered,
    totalLines: lines.length,
    start,
    end: start + slice.length - 1,
  };
}

function formatInspectOutput(rawJson: string): { text: string; isError: boolean } {
  const data = JSON.parse(rawJson);
  if (!data?.ok) {
    return { text: `vn_re_inspect failed: ${data?.error || rawJson}`, isError: true };
  }
  const action = data.action;
  if (action === 'archive') {
    const lines = [
      `[archive] ${data.path} (${data.size} B)`,
      `head64: ${data.head_64_hex}`,
      `tail64: ${data.tail_64_hex}`,
      `head_4k: ${(data.head_chunks_4k || []).slice(0, 8).map((c: any) => `${c.offset}:ent=${c.entropy},z=${c.zero_ratio}`).join(' | ')}`,
      `tail_4k: ${(data.tail_chunks_4k || []).slice(-6).map((c: any) => `${c.offset}:ent=${c.entropy},z=${c.zero_ratio}`).join(' | ')}`,
      `autocorr: ${Object.entries(data.autocorrelation || {}).map(([k, v]) => `lag${k}=${v}`).join(' ')}`,
      `magic_hits(${(data.magic_hits || []).length}): ${(data.magic_hits || []).map((m: any) => `${m.magic}@${m.hex_offset}`).join(', ') || 'none'}`,
    ];
    return { text: lines.join('\n'), isError: false };
  }
  if (action === 'pe_overview') {
    const lines = [
      `[pe_overview] arch=${data.arch} ImageBase=${data.image_base} Entry=${data.entry_point_va} total_imports=${data.import_count}`,
      ...(data.packed_hints?.length ? [`packed_hints: ${data.packed_hints.join('; ')}`] : []),
      'sections:',
      ...(data.sections || []).map(
        (s: any) => `  ${s.name} VA=${s.va} vsize=${s.vsize} raw=${s.raw_offset}+${s.raw_size} exec=${s.exec} ent=${s.entropy}`
      ),
      'key_win32_apis:',
      ...(data.key_win32_apis || []).slice(0, 40).map(
        (a: any) => `  ${a.dll}!${a.name} iat=${a.iat_va}${a.delay ? ' (delay)' : ''}`
      ),
      `rtti_classes(${(data.rtti_classes || []).length}): ${(data.rtti_classes || []).join(', ') || 'none'}`,
    ];
    return { text: lines.join('\n'), isError: false };
  }
  if (action === 'xrefs') {
    const lines = [
      `[xrefs] arch=${data.arch} targets=${(data.targets || []).map((t: any) => `${t.label}@${t.va}`).join(', ') || 'none'}`,
      `hits(${(data.hits || []).length}):`,
      ...(data.hits || []).map((h: any) => `  ${h.va}: ${h.insn}  ; ${h.target} (${h.target_va})`),
    ];
    if (data.note) lines.push(`note: ${data.note}`);
    return { text: lines.join('\n'), isError: false };
  }
  if (action === 'disasm') {
    const lines = [
      `[disasm] arch=${data.arch} section=${data.section} start=${data.start_va} count=${(data.instructions || []).length}`,
      ...(data.neighbor_prologues?.length ? [`neighbor_prologues: ${data.neighbor_prologues.join(', ')}`] : []),
      ...(data.raw_head_hex ? [`raw_head_hex: ${data.raw_head_hex}`] : []),
      ...(data.instructions || []).map(
        (ins: any) => `  ${ins.va}  ${ins.bytes.padEnd(18, ' ')}  ${ins.insn}${ins.note ? `  ; ${ins.note}` : ''}`
      ),
    ];
    if (data.note) lines.push(`note: ${data.note}`);
    return { text: lines.join('\n'), isError: false };
  }
  return { text: rawJson, isError: false };
}

function formatTraceRegs(regs: any): string {
  if (!regs || typeof regs !== 'object') return '';
  return Object.entries(regs)
    .filter(([, val]) => typeof val === 'string' && val.length > 0)
    .map(([k, val]) => `${k}=${val}`)
    .join(' ');
}

export function formatTraceOutput(rawJson: string): { text: string; isError: boolean } {
  const data = JSON.parse(rawJson);
  if (!data?.ok) {
    return { text: `vn_re_trace failed: ${data?.error || rawJson}`, isError: true };
  }
  if (!data.supported) {
    return { text: `vn_re_trace unsupported: ${data.reason || 'Windows required'}`, isError: false };
  }
  const rw = data.read_watch || {};
  const lines = [
    `[vn_re_trace] mode=${data.mode} arch=${data.arch} stop=${data.stop_reason} imageBase=${data.main_image_base} preferredBase=${data.preferred_image_base || '?'}`,
    `hooked_apis: ${(data.hooked_apis || []).join(', ') || 'none'}`,
    `loose_file_probes(${(data.loose_file_probes || []).length}):`,
    ...(data.loose_file_probes || []).map((p: any) => {
      const callers = (p.callers_static_va?.length ? p.callers_static_va : p.callers_va) || [];
      return `  ${p.api} "${p.path}" callers=[${callers.join(', ')}]`;
    }),
    `io_events(${(data.io_events || []).length}):`,
    ...(data.io_events || []).slice(0, 35).map((e: any) => {
      const extra =
        e.api === 'ReadFile'
          ? ` off=${e.file_offset} read=${e.actual_read}/${e.requested} buf=${e.buf_addr} head=${e.head_hex}`
          : '';
      const callers = (e.callers_static_va?.length ? e.callers_static_va : e.callers_va) || [];
      return `  ${e.api} "${e.path}"${extra} callers=[${callers.join(', ')}]`;
    }),
  ];
  if (data.mode === 'read_watch') {
    if (rw.prev16_before_hex) {
      lines.push(`prev16_before: ${rw.prev16_before_hex}`);
    }
    lines.push(
      `read_watch: armed=${Boolean(rw.armed)} file="${rw.file || ''}" off=${rw.read_offset ?? 0} addr=${rw.watch_addr || 'none'}`,
      `before_32B: ${rw.before_hex || ''}`,
      'timing_note: DR0 fires right after the touching instruction completes; prev16 shows bytes already modified by earlier loop iterations while bytes after watch_addr+1 may still be unmodified.',
      `watch_hits(${(rw.hits || []).length}):`,
      ...(rw.hits || []).map((h: any) => {
        const callers = (h.callers_static_va?.length ? h.callers_static_va : h.callers_va) || [];
        const regsStr = formatTraceRegs(h.regs);
        const prevPart = h.prev16_hex ? ` prev16=${h.prev16_hex}` : '';
        const regsPart = regsStr ? ` regs={${regsStr}}` : '';
        return `  staticVA=${h.static_va || '?'} VA=${h.insn_va} mod=${h.module || '?'} rva=${h.rva || '?'} main=${h.in_main_exe} changed=${h.changed_from_read}${regsPart} callers=[${callers.join(', ')}]${prevPart} after=${h.after_hex}`;
      })
    );
  }
  return { text: lines.join('\n'), isError: false };
}

export function createReverserTools(
  getWorkspace: () => string,
  options: ReverserToolOptions = {}
): ToolDefinition<any, any>[] {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const pythonExec = options.pythonPath || config.pythonPath;
  const sanitize = (text: string) => redactSecrets(text, options.getKnownSecrets?.());

  const vnReInspect = defineTool({
    name: 'vn_re_inspect',
    label: 'VN Static RE Inspector',
    description:
      'Deterministic static triage for VN archives and PE executables (pefile + capstone). Supports archive entropy/magic scan, PE overview (sections/IAT/RTTI), verified VA/string/API xrefs, and annotated disassembly with neighbor function discovery.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('archive'),
        Type.Literal('pe_overview'),
        Type.Literal('xrefs'),
        Type.Literal('disasm'),
      ]),
      path: Type.String({ description: 'Workspace-relative path to archive or .exe/.dll target' }),
      rttiFilter: Type.Optional(Type.String({ description: 'Filter keyword for RTTI class names (pe_overview)' })),
      string: Type.Optional(Type.String({ description: 'String literal to locate xrefs for (xrefs)' })),
      api: Type.Optional(Type.String({ description: 'Win32 API name to locate IAT xrefs for (xrefs)' })),
      va: Type.Optional(Type.String({ description: 'Target virtual address in hex, e.g. 0x6409d7 (xrefs/disasm)' })),
      maxInsns: Type.Optional(Type.Number({ description: 'Max instructions to disassemble (10..240, default 90)' })),
      neighbors: Type.Optional(Type.Boolean({ description: 'Also list nearby function prologues within +/-0x600 (disasm)' })),
      maxHits: Type.Optional(Type.Number({ description: 'Max xref hits to return (default 40)' })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const ws = getWorkspace();
        const { absPath } = resolveWorkspaceTargetFile(ws, params.path);
        const scriptPath = resolveReScriptPath('re_inspect.py');
        const args = [scriptPath, params.action, absPath];
        if (params.action === 'pe_overview') {
          if (params.rttiFilter?.trim()) args.push('--rtti-filter', params.rttiFilter.trim());
        } else if (params.action === 'xrefs') {
          if (params.string) args.push('--string', params.string);
          if (params.api) args.push('--api', params.api);
          if (params.va) args.push('--va', params.va);
          if (typeof params.maxHits === 'number') args.push('--max-hits', String(Math.max(1, Math.min(80, Math.floor(params.maxHits)))));
        } else if (params.action === 'disasm') {
          if (!params.va?.trim()) {
            return {
              content: [{ type: 'text' as const, text: 'vn_re_inspect(disasm) requires va parameter (e.g. "0x6409d7").' }],
              details: { exitCode: 1 },
              isError: true,
            };
          }
          args.push('--va', params.va.trim());
          if (typeof params.maxInsns === 'number') {
            args.push('--max-insns', String(Math.max(10, Math.min(240, Math.floor(params.maxInsns)))));
          }
          if (params.neighbors) args.push('--neighbors');
        }
        const { stdout } = await execFileAsync(pythonExec, args, {
          cwd: ws,
          timeout: INSPECT_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          signal,
        });
        const formatted = formatInspectOutput(stdout.trim());
        return {
          content: [{ type: 'text' as const, text: sanitize(formatted.text) }],
          details: { exitCode: formatted.isError ? 1 : 0 },
          ...(formatted.isError ? { isError: true } : {}),
        };
      } catch (err: any) {
        const rawOut = typeof err?.stdout === 'string' && err.stdout.trim() ? err.stdout.trim() : '';
        if (rawOut.startsWith('{')) {
          try {
            const parsed = formatInspectOutput(rawOut);
            return {
              content: [{ type: 'text' as const, text: sanitize(parsed.text) }],
              details: { exitCode: 1 },
              isError: true,
            };
          } catch {
            // fall through
          }
        }
        return {
          content: [{ type: 'text' as const, text: sanitize(`vn_re_inspect error: ${err?.message || err}`) }],
          details: { exitCode: 1 },
          isError: true,
        };
      }
    },
  });

  const lookupRepoTree = async (
    repo: string,
    branchHint: string,
    filterQuery: string,
    signal?: AbortSignal
  ): Promise<{ status: number; header?: string; paths?: string[]; truncated?: boolean; errorText?: string }> => {
    const explicitBranch = branchHint.trim();
    let branch = explicitBranch;
    if (!branch) {
      const metaRes = await fetchBoundedText(
        `https://api.github.com/repos/${repo}`,
        fetchFn,
        { Accept: 'application/vnd.github+json' },
        signal,
        MAX_SEARCH_JSON_BYTES
      );
      if (metaRes.status >= 200 && metaRes.status < 300) {
        const meta = JSON.parse(metaRes.text);
        branch = String(meta?.default_branch || 'master');
      } else {
        branch = 'master';
      }
    }

    let treeRes = await fetchBoundedText(
      `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      fetchFn,
      { Accept: 'application/vnd.github+json' },
      signal,
      MAX_TREE_JSON_BYTES
    );
    if (!explicitBranch && branch === 'master' && treeRes.status === 404) {
      const mainRes = await fetchBoundedText(
        `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
        fetchFn,
        { Accept: 'application/vnd.github+json' },
        signal,
        MAX_TREE_JSON_BYTES
      );
      if (mainRes.status >= 200 && mainRes.status < 300) {
        branch = 'main';
        treeRes = mainRes;
      }
    }

    if (treeRes.status < 200 || treeRes.status >= 300) {
      return { status: treeRes.status, errorText: `GitHub tree HTTP ${treeRes.status} for ${repo}@${branch}` };
    }

    const treeJson = JSON.parse(treeRes.text);
    const allBlobs: string[] = (Array.isArray(treeJson?.tree) ? treeJson.tree : [])
      .filter((n: any) => n?.type === 'blob' && typeof n.path === 'string')
      .map((n: any) => String(n.path));

    const tokens = filterQuery
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    let matched: string[];
    if (tokens.length === 0) {
      matched = allBlobs;
    } else {
      matched = allBlobs.filter((p) => {
        const low = p.toLowerCase();
        return tokens.every((tok) => low.includes(tok));
      });
      if (matched.length === 0 && tokens.length > 1) {
        matched = allBlobs.filter((p) => {
          const low = p.toLowerCase();
          return tokens.some((tok) => low.includes(tok));
        });
      }
    }
    const sliced = matched.slice(0, 60);
    return {
      status: treeRes.status,
      header: `[tree] ${repo}@${branch} matched=${sliced.length}${treeJson?.truncated ? ' (tree truncated)' : ''}`,
      paths: sliced,
      truncated: Boolean(treeJson?.truncated),
    };
  };

  const vnReLookup = defineTool({
    name: 'vn_re_lookup',
    label: 'VN Public RE Spec Lookup',
    description:
      'Read-only lookup of public open-source VN unpackers (GitHub API + raw + allowlisted RE sites). Use search for repo discovery (or pass repo="owner/name" to search its file tree), tree to list/filter files inside a repo, and fetch to read raw files or allowlisted RE articles.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('search'), Type.Literal('tree'), Type.Literal('fetch')]),
      query: Type.Optional(Type.String({ description: 'Search keyword(s) or space-separated path filter tokens (search/tree)' })),
      repo: Type.Optional(Type.String({ description: 'GitHub owner/repo, e.g. morkt/GARbro (tree/fetch, or search within that repo)' })),
      path: Type.Optional(Type.String({ description: 'File path inside repo (fetch)' })),
      branch: Type.Optional(Type.String({ description: 'GitHub branch (default auto-detected or master->main fallback)' })),
      url: Type.Optional(Type.String({ description: 'Allowlisted https URL (fetch)' })),
      startLine: Type.Optional(Type.Number({ description: '1-based start line for fetch pagination (default 1)' })),
      maxLines: Type.Optional(Type.Number({ description: 'Max lines per fetch slice (10..250, default 140)' })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const ws = getWorkspace();
        const cfg = readVnResearchConfig(ws);
        if (!cfg.allowReLookup) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'vn_re_lookup is disabled by configuration ([vn.research] allow_re_lookup = false or PAPERCUP_RE_LOOKUP_ENABLED=false). Use local vn_re_inspect and vn_re_trace instead.',
              },
            ],
            details: { exitCode: 0, disabled: true } as { exitCode: number; disabled?: boolean },
          };
        }

        if (params.action === 'search') {
          const q = (params.query || '').trim();
          const explicitRepo = (params.repo || '').trim();
          const embeddedRepoMatch = !explicitRepo ? /\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i.exec(q) : null;
          const targetRepo = explicitRepo || embeddedRepoMatch?.[1] || '';
          if (!q && !targetRepo) {
            return {
              content: [{ type: 'text' as const, text: 'vn_re_lookup(search) requires query (or repo).' }],
              details: { exitCode: 1 },
              isError: true,
            };
          }

          const cleanedQuery = q
            .replace(/\brepo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/gi, ' ')
            .replace(/\b(?:filename|path):([^\s]+)/gi, '$1')
            .replace(/\bin:file\b/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const qTokens = (cleanedQuery || q).toLowerCase().split(/\s+/).filter(Boolean);
          const curatedHits = CURATED_VN_RE_REPOS.filter((r) => {
            const hay = `${r.repo} ${r.description} ${r.tags.join(' ')}`.toLowerCase();
            return (
              r.repo.toLowerCase() === targetRepo.toLowerCase() ||
              qTokens.some((tok) => hay.includes(tok))
            );
          });

          const lines: string[] = [];
          if (curatedHits.length > 0) {
            lines.push('Curated VN RE repositories:');
            for (const c of curatedHits) {
              lines.push(`  - ${c.repo}: ${c.description}`);
            }
          }

          if (targetRepo) {
            if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(targetRepo)) {
              return {
                content: [{ type: 'text' as const, text: 'vn_re_lookup(search) repo must be in "owner/name" format.' }],
                details: { exitCode: 1 },
                isError: true,
              };
            }
            const treeOutcome = await lookupRepoTree(
              targetRepo,
              params.branch || '',
              cleanedQuery || q,
              signal
            );
            if (treeOutcome.errorText) {
              return {
                content: [{ type: 'text' as const, text: sanitize(treeOutcome.errorText) }],
                details: { exitCode: 1 },
                isError: true,
              };
            }
            lines.push(treeOutcome.header!);
            lines.push(...(treeOutcome.paths || []).map((p) => `  ${p}`));
            lines.push(RE_LOOKUP_CONSTRAINT_FOOTER.trim());
            return {
              content: [{ type: 'text' as const, text: sanitize(lines.join('\n')) }],
              details: { exitCode: 0 },
            };
          }

          const searchQuery = cleanedQuery || q;
          try {
            const runGhRepoSearch = async (queryText: string) => {
              const ghUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(queryText)}&per_page=8`;
              return await fetchBoundedText(
                ghUrl,
                fetchFn,
                { Accept: 'application/vnd.github+json' },
                signal,
                MAX_SEARCH_JSON_BYTES
              );
            };

            let res = await runGhRepoSearch(searchQuery);
            let items: any[] = [];
            if (res.status >= 200 && res.status < 300) {
              const body = JSON.parse(res.text);
              items = Array.isArray(body?.items) ? body.items : [];
              const words = searchQuery.split(/\s+/).filter(Boolean);
              if (items.length === 0 && words.length > 2) {
                const simpler = words.slice(0, 2).join(' ');
                const retryRes = await runGhRepoSearch(simpler);
                if (retryRes.status >= 200 && retryRes.status < 300) {
                  const retryBody = JSON.parse(retryRes.text);
                  items = Array.isArray(retryBody?.items) ? retryBody.items : [];
                  res = retryRes;
                }
              }
            }
            if (res.status >= 200 && res.status < 300) {
              lines.push(`GitHub search (${items.length} results):`);
              for (const item of items.slice(0, 8)) {
                lines.push(
                  `  - ${item.full_name} (stars=${item.stargazers_count ?? 0}, branch=${item.default_branch || 'master'}): ${(item.description || '').slice(0, 140)}`
                );
              }
              if (items.length === 0) {
                lines.push('Tip: For files inside a specific repository, call vn_re_lookup(action="tree", repo="owner/name", query="keyword").');
              }
            } else {
              lines.push(`GitHub search returned HTTP ${res.status}; use curated repositories above or vn_re_lookup(tree).`);
            }
          } catch (err: any) {
            lines.push(`GitHub search request failed (${err?.message || err}); curated repositories remain available.`);
          }
          lines.push(RE_LOOKUP_CONSTRAINT_FOOTER.trim());
          return {
            content: [{ type: 'text' as const, text: sanitize(lines.join('\n')) }],
            details: { exitCode: 0 },
          };
        }

        if (params.action === 'tree') {
          const repo = (params.repo || '').trim();
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
            return {
              content: [{ type: 'text' as const, text: 'vn_re_lookup(tree) requires repo in "owner/name" format.' }],
              details: { exitCode: 1 },
              isError: true,
            };
          }
          const treeOutcome = await lookupRepoTree(repo, params.branch || '', params.query || '', signal);
          if (treeOutcome.errorText) {
            return {
              content: [{ type: 'text' as const, text: sanitize(treeOutcome.errorText) }],
              details: { exitCode: 1 },
              isError: true,
            };
          }
          const out = [
            treeOutcome.header!,
            ...(treeOutcome.paths || []).map((p: string) => `  ${p}`),
            RE_LOOKUP_CONSTRAINT_FOOTER.trim(),
          ].join('\n');
          return {
            content: [{ type: 'text' as const, text: sanitize(out) }],
            details: { exitCode: 0 },
          };
        }

        // fetch
        let targetUrl = (params.url || '').trim();
        let fallbackUrl = '';
        if (!targetUrl) {
          const repo = (params.repo || '').trim();
          const relPath = (params.path || '').trim().replace(/^\/+/, '');
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !relPath || relPath.includes('..')) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'vn_re_lookup(fetch) requires either an allowlisted https url or repo + path.',
                },
              ],
              details: { exitCode: 1 },
              isError: true,
            };
          }
          const explicitBranch = (params.branch || '').trim();
          const branch = explicitBranch || 'master';
          targetUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${relPath}`;
          if (!explicitBranch) {
            fallbackUrl = `https://raw.githubusercontent.com/${repo}/main/${relPath}`;
          }
        }

        let fetched = await fetchBoundedText(targetUrl, fetchFn, {}, signal, MAX_FETCH_BYTES);
        if (fetched.status === 404 && fallbackUrl) {
          const fallbackFetched = await fetchBoundedText(fallbackUrl, fetchFn, {}, signal, MAX_FETCH_BYTES);
          if (fallbackFetched.status >= 200 && fallbackFetched.status < 300) {
            fetched = fallbackFetched;
            targetUrl = fallbackUrl;
          }
        }
        if (fetched.status < 200 || fetched.status >= 300) {
          return {
            content: [{ type: 'text' as const, text: `vn_re_lookup(fetch) HTTP ${fetched.status} for ${targetUrl}` }],
            details: { exitCode: 1 },
            isError: true,
          };
        }
        const plainText = fetched.contentType.toLowerCase().includes('html')
          ? stripHtmlToText(fetched.text)
          : fetched.text;
        const sliced = sliceLines(plainText, params.startLine, params.maxLines);
        const out = [
          `[fetch] ${targetUrl} (lines ${sliced.start}..${sliced.end} of ${sliced.totalLines})`,
          sliced.sliced,
          RE_LOOKUP_CONSTRAINT_FOOTER.trim(),
        ].join('\n');
        return {
          content: [{ type: 'text' as const, text: sanitize(out) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: sanitize(`vn_re_lookup error: ${err?.message || err}`) }],
          details: { exitCode: 1 },
          isError: true,
        };
      }
    },
  });

  const vnReTrace = defineTool({
    name: 'vn_re_trace',
    label: 'VN Controlled Win32 I/O & DR0 Tracer',
    description:
      'Runs the target game executable inside an isolated hardlink sandbox under a Win32 Job Object and Debug API (<=45s) to trace loose-file override checks (CreateFile/GetFileAttributes) and ReadFile buffer DR0 hardware watchpoints pointing straight to the decryption/decompression instruction VA.',
    parameters: Type.Object({
      exe: Type.String({ description: 'Workspace-relative path to target .exe' }),
      mode: Type.Union([Type.Literal('io_trace'), Type.Literal('read_watch')]),
      targetFilter: Type.Optional(Type.String({ description: 'Substring filter for target archive/file path, e.g. Scene.pck' })),
      minOffset: Type.Optional(Type.Number({ description: 'Minimum file offset for ReadFile capture (default 0)' })),
      maxOffset: Type.Optional(Type.Number({ description: 'Maximum file offset for ReadFile capture (-1 = unlimited)' })),
      minSize: Type.Optional(Type.Number({ description: 'Minimum ReadFile byte count to capture (default 1)' })),
      watchOffset: Type.Optional(Type.Number({ description: 'Byte offset inside ReadFile buffer to arm DR0 watchpoint (default 0)' })),
      maxHits: Type.Optional(Type.Number({ description: 'Max distinct DR0 instruction VAs to capture (default 12)' })),
      timeoutSec: Type.Optional(Type.Number({ description: 'Wall-clock limit in seconds (5..45, default 20)' })),
    }),
    async execute(_toolCallId, params, signal) {
      if (process.platform !== 'win32') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'vn_re_trace is supported only on Windows hosts; fall back to vn_re_inspect static analysis.',
            },
          ],
          details: { exitCode: 0, supported: false } as { exitCode: number; supported?: boolean },
        };
      }

      let sandbox: ReturnType<typeof prepareReadOnlyTraceSandbox> | null = null;
      try {
        const ws = getWorkspace();
        sandbox = prepareReadOnlyTraceSandbox(ws, params.exe);
        const scriptPath = resolveReScriptPath('re_trace.py');
        const timeoutSec = Math.max(
          MIN_TRACE_TIMEOUT_SEC,
          Math.min(MAX_TRACE_TIMEOUT_SEC, Math.floor(params.timeoutSec ?? DEFAULT_TRACE_TIMEOUT_SEC))
        );
        const args = [
          scriptPath,
          '--exe',
          sandbox.exePath,
          '--cwd',
          path.dirname(sandbox.exePath),
          '--mode',
          params.mode,
          '--timeout-sec',
          String(timeoutSec),
        ];
        if (params.targetFilter?.trim()) args.push('--target-filter', params.targetFilter.trim());
        if (typeof params.minOffset === 'number') args.push('--min-offset', String(Math.max(0, Math.floor(params.minOffset))));
        if (typeof params.maxOffset === 'number') args.push('--max-offset', String(Math.floor(params.maxOffset)));
        if (typeof params.minSize === 'number') args.push('--min-size', String(Math.max(1, Math.floor(params.minSize))));
        if (typeof params.watchOffset === 'number') args.push('--watch-offset', String(Math.max(0, Math.floor(params.watchOffset))));
        if (typeof params.maxHits === 'number') args.push('--max-hits', String(Math.max(1, Math.min(30, Math.floor(params.maxHits)))));

        const { stdout } = await execFileAsync(pythonExec, args, {
          cwd: path.dirname(sandbox.exePath),
          timeout: (timeoutSec + 10) * 1000,
          maxBuffer: 2 * 1024 * 1024,
          signal,
        });
        const formatted = formatTraceOutput(stdout.trim());
        return {
          content: [{ type: 'text' as const, text: sanitize(formatted.text) }],
          details: { exitCode: formatted.isError ? 1 : 0 },
          ...(formatted.isError ? { isError: true } : {}),
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: sanitize(`vn_re_trace error: ${err?.message || err}`) }],
          details: { exitCode: 1 },
          isError: true,
        };
      } finally {
        sandbox?.cleanup();
      }
    },
  });

  const vnPatchFont = defineTool({
    name: 'vn_patch_font',
    label: 'VN Patch Bundled Font',
    description:
      'Patch a bundled game font (.ttf/.otf/.ttc) in-place with missing target-language (e.g. GB2312/Chinese) glyphs copied from a system CJK fallback font while preserving base font family name, unitsPerEm, vertical metrics, Shift-JIS codepage bit, and CJK advance width. Supports optional remapMode="sjis_fullwidth_slots" for zero-DLL CP932 fullwidth slot remapping (.papercup/data/vn/fonts/char_remap.json). Outputs to .papercup/data/vn/fonts/files/<install_rel> and updates .papercup/data/vn/fonts/manifest.json (automatically included in smoke test overlays and vn_writeback patch bundles).',
    parameters: Type.Object({
      baseFont: Type.Optional(
        Type.String({
          description:
            'Optional workspace-relative path to the bundled game font (auto-selected when exactly one bundled font needs patching)',
        })
      ),
      fallbackFont: Type.Optional(
        Type.String({
          description:
            'Optional path to a fallback CJK font file (.ttf/.otf/.ttc); defaults to system CJK fonts such as simhei.ttf / msyh.ttc',
        })
      ),
      includeGb2312: Type.Optional(
        Type.Boolean({
          description:
            'Include full GB2312 Level-1/2 Hanzi (~6,763 chars) and standard full-width Chinese punctuation in addition to translated workspace chars (default true)',
        })
      ),
      remapMode: Type.Optional(
        Type.Union([Type.Literal('none'), Type.Literal('sjis_fullwidth_slots')], {
          description:
            'Optional CP932 slot remapping mode: "none" (default, standard Unicode cmap patching) or "sjis_fullwidth_slots" (zero-DLL mode: remaps non-CP932 chars onto rare JIS X 0208 Level-2 fullwidth Kanji slots and writes char_remap.json)',
        })
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      try {
        const ws = getWorkspace();
        const text = await patchWorkspaceFont(ws, {
          baseFont: params.baseFont?.trim() || undefined,
          fallbackFont: params.fallbackFont?.trim() || undefined,
          includeGb2312: params.includeGb2312,
          remapMode: params.remapMode,
          signal,
        });
        return {
          content: [{ type: 'text' as const, text: sanitize(text || 'Font patch completed.') }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: sanitize(`vn_patch_font error: ${err?.message || err}`) }],
          details: { exitCode: 1 },
          isError: true,
        };
      }
    },
  });

  return [vnReInspect, vnReLookup, vnReTrace, vnPatchFont];
}
