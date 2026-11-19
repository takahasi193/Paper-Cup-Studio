/**
 * Built-in VN archive containers (RPA, XP3, PE+ZIP, NSA), workspace archive scanner,
 * engine profiles/library matching, harness overlay, and sandboxed custom script runner.
 * Pure TypeScript using Node built-in modules (no Python core required).
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { config } from '../config.js';
import {
  decodeCp932Bytes,
  encodeCp932Bytes,
  isSymlinkPath,
  projectHarnessDir,
  realpathSafe,
} from './profile.js';

const execFileAsync = promisify(execFile);

export const RPA_MANIFEST = '.rpa-manifest.json';
export const XP3_MANIFEST = '.xp3-manifest.json';
export const PEZIP_MANIFEST = '.pe-zip-manifest.json';
export const NSA_MANIFEST = '.nsa-manifest.json';
export const SKILL_MANIFEST = '.skill-manifest.json';
export const COMPOSE_MANIFEST = '.compose-manifest.json';

export const BUILTIN_ARCHIVE_KINDS = new Set(['rpa', 'xp3', 'pe-zip', 'nsa']);
export const NO_UNPACKER_KINDS = new Set(['wolf', 'nscript', 'serialized']);

export const MAX_SCAN_FILES = 256;
export const MAX_SCAN_DEPTH = 8;
export const MAX_LAYOUT_DIRS = 128;
export const MAX_UNKNOWN_FILES = 16;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_INDEX_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 65536;
export const SCRIPT_TIMEOUT_MS = 30_000;
export const MAX_SCRIPT_BYTES = 256 * 1024;

export const SKILL_POINTER = 'skill';
export const SKILL_DIGEST = 'skill-sha256';
export const UNPACK_DIGEST = 'unpack-sha256';
export const REPACK_DIGEST = 'repack-sha256';
export const EXTRACT_DIGEST = 'extract-sha256';
export const APPLY_DIGEST = 'apply-sha256';

const ENGINE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DRIVE_RE = /^[A-Za-z]:/;
const RPA_LINE_RE = /^RPA-(2\.0|3\.0|3\.2) ([0-9A-Fa-f]{8,16})(?: ([0-9A-Fa-f]{8}))?(?:\r?\n|$)/;
const XP3_MAGIC = Buffer.from([0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01]);
const DATA_DIR_RE = /^.+_data$/;
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.papercup',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'unpacked',
  'work',
  'build',
  'results',
  'release',
  'classify-src',
]);
const PRIORITY_SUFFIX = new Set(['.rpa', '.xp3', '.int', '.unity3d', '.bundle', '.assets', '.exe', '.wolf', '.nsa']);
const CANDIDATE_SUFFIX = new Set([
  '.rpa', '.xp3', '.int', '.unity3d', '.bundle', '.assets', '.exe', '.wolf',
  '.pak', '.dat', '.bin', '.arc', '.pack', '.vol', '.cpk',
  '.nsa', '.sar', '.pfs', '.yks', '.ypf', '.pck', '.zip', '.7z', '.rar',
]);
const RESERVED_CUSTOM_ENGINES = new Set(['renpy', 'kirikiri', 'nscripter']);

export const HARNESS_COMPONENTS = [
  'prompt.md',
  'guardrails.md',
  'tools.md',
  'structure.md',
  'engine.json',
  'scripts/unpack.py',
  'scripts/repack.py',
] as const;

const BUILTIN_ENGINE_JSON: Record<string, Record<string, unknown>> = {
  kirikiri: {
    name: 'kirikiri',
    kinds: ['xp3'],
    versions: ['basic', 'extra'],
    script_root: 'scenario',
    encodings: ['cp932', 'utf-16le', 'utf-8'],
  },
  renpy: {
    name: 'renpy',
    kinds: ['rpa'],
    versions: ['2.0', '3.0', '3.2'],
    script_root: 'game',
    encodings: ['utf-8', 'utf-8-bom', 'cp932'],
  },
};

export class ArchiveError extends Error {}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function adler32(data: Buffer): number {
  const MOD = 65521;
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % MOD;
    s2 = (s2 + s1) % MOD;
  }
  return ((s2 << 16) | s1) >>> 0;
}

export function staysInside(root: string, name: string): string {
  const normalized = name.replace(/\\/g, '/').trim();
  if (!normalized || normalized.includes('\x00') || DRIVE_RE.test(normalized) || normalized.startsWith('/')) {
    throw new ArchiveError(`路径不合法：${name}`);
  }
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) {
    throw new ArchiveError(`路径不合法：${name}`);
  }
  const base = realpathSafe(root);
  const dest = path.resolve(base, ...parts);
  const rel = path.relative(base, dest);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ArchiveError(`路径不合法：${name}`);
  }
  return dest;
}

function collectFilesFlat(root: string, ignoreManifest: string): Array<[string, Buffer]> {
  const found: Array<[string, Buffer]> = [];
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (isSymlinkPath(full)) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name === ignoreManifest) continue;
        const rel = path.relative(root, full).replace(/\\/g, '/');
        found.push([rel, fs.readFileSync(full)]);
      }
    }
  }
  walk(root);
  found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return found;
}

export function atomicWriteWithBackup(dest: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    if (fs.existsSync(dest)) {
      const bak = dest + '.bak';
      if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
      fs.renameSync(dest, bak);
    }
    fs.renameSync(tmp, dest);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/* ========================= Python Pickle Subset VM & Encoder (for RPA) ========================= */

function decodePickle(buf: Buffer): Record<string, Array<[number, number, Buffer]>> {
  let pos = 0;
  const stack: unknown[] = [];
  const marks: number[] = [];
  const memo = new Map<string, unknown>();

  const popMark = (): unknown[] => {
    const idx = marks.pop();
    if (idx === undefined) throw new ArchiveError('无法解析 RPA 索引 (MARK underflow)');
    return stack.splice(idx, stack.length - idx);
  };
  const readLine = (): string => {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) throw new ArchiveError('无法解析 RPA 索引 (unterminated line)');
    const line = buf.subarray(pos, nl).toString('latin1').replace(/\r$/, '');
    pos = nl + 1;
    return line;
  };
  const toSignedBigInt = (bytes: Buffer): bigint => {
    if (bytes.length === 0) return 0n;
    let val = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) {
      val = (val << 8n) | BigInt(bytes[i]);
    }
    if (bytes[bytes.length - 1] & 0x80) {
      val -= 1n << BigInt(bytes.length * 8);
    }
    return val;
  };

  while (pos < buf.length) {
    const op = buf[pos++];
    if (op === 0x2e) {
      // '.' STOP
      break;
    }
    switch (op) {
      case 0x80: // PROTO
        pos += 1;
        break;
      case 0x95: // FRAME (8 bytes uint64 len)
        pos += 8;
        break;
      case 0x28: // '(' MARK
        marks.push(stack.length);
        break;
      case 0x7d: // '}' EMPTY_DICT
        stack.push({});
        break;
      case 0x5d: // ']' EMPTY_LIST
        stack.push([]);
        break;
      case 0x29: // ')' EMPTY_TUPLE
        stack.push([]);
        break;
      case 0x61: { // 'a' APPEND
        const item = stack.pop();
        const list = stack[stack.length - 1] as unknown[];
        if (!Array.isArray(list)) throw new ArchiveError('无法解析 RPA 索引');
        list.push(item);
        break;
      }
      case 0x65: { // 'e' APPENDS
        const items = popMark();
        const list = stack[stack.length - 1] as unknown[];
        if (!Array.isArray(list)) throw new ArchiveError('无法解析 RPA 索引');
        list.push(...items);
        break;
      }
      case 0x6c: // 'l' LIST
        stack.push(popMark());
        break;
      case 0x74: // 't' TUPLE
        stack.push(popMark());
        break;
      case 0x85: { // TUPLE1
        const a = stack.pop();
        stack.push([a]);
        break;
      }
      case 0x86: { // TUPLE2
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b]);
        break;
      }
      case 0x87: { // TUPLE3
        const c = stack.pop();
        const b = stack.pop();
        const a = stack.pop();
        stack.push([a, b, c]);
        break;
      }
      case 0x64: { // 'd' DICT
        const items = popMark();
        const obj: Record<string, unknown> = {};
        for (let i = 0; i + 1 < items.length; i += 2) {
          obj[String(items[i])] = items[i + 1];
        }
        stack.push(obj);
        break;
      }
      case 0x73: { // 's' SETITEM
        const val = stack.pop();
        const key = stack.pop();
        const dict = stack[stack.length - 1] as Record<string, unknown>;
        if (!dict || typeof dict !== 'object') throw new ArchiveError('无法解析 RPA 索引');
        dict[key instanceof Buffer ? key.toString('utf8') : String(key)] = val;
        break;
      }
      case 0x75: { // 'u' SETITEMS
        const items = popMark();
        const dict = stack[stack.length - 1] as Record<string, unknown>;
        if (!dict || typeof dict !== 'object') throw new ArchiveError('无法解析 RPA 索引');
        for (let i = 0; i + 1 < items.length; i += 2) {
          const k = items[i];
          dict[k instanceof Buffer ? k.toString('utf8') : String(k)] = items[i + 1];
        }
        break;
      }
      case 0x4b: // 'K' BININT1
        stack.push(buf[pos++]);
        break;
      case 0x4d: // 'M' BININT2
        stack.push(buf.readUInt16LE(pos));
        pos += 2;
        break;
      case 0x4a: // 'J' BININT
        stack.push(buf.readInt32LE(pos));
        pos += 4;
        break;
      case 0x49: { // 'I' INT
        const line = readLine();
        stack.push(BigInt(line));
        break;
      }
      case 0x4c: { // 'L' LONG
        const line = readLine().replace(/L$/, '');
        stack.push(BigInt(line));
        break;
      }
      case 0x8a: { // LONG1
        const n = buf[pos++];
        const val = toSignedBigInt(buf.subarray(pos, pos + n));
        pos += n;
        stack.push(val);
        break;
      }
      case 0x8b: { // LONG4
        const n = buf.readInt32LE(pos);
        pos += 4;
        const val = toSignedBigInt(buf.subarray(pos, pos + n));
        pos += n;
        stack.push(val);
        break;
      }
      case 0x8c: { // SHORT_BINUNICODE
        const n = buf[pos++];
        stack.push(buf.subarray(pos, pos + n).toString('utf8'));
        pos += n;
        break;
      }
      case 0x58: { // 'X' BINUNICODE
        const n = buf.readUInt32LE(pos);
        pos += 4;
        stack.push(buf.subarray(pos, pos + n).toString('utf8'));
        pos += n;
        break;
      }
      case 0x8d: { // BINUNICODE8
        const n = Number(buf.readBigUInt64LE(pos));
        pos += 8;
        stack.push(buf.subarray(pos, pos + n).toString('utf8'));
        pos += n;
        break;
      }
      case 0x56: // 'V' UNICODE
        stack.push(readLine());
        break;
      case 0x43: { // 'C' SHORT_BINBYTES
        const n = buf[pos++];
        stack.push(Buffer.from(buf.subarray(pos, pos + n)));
        pos += n;
        break;
      }
      case 0x42: { // 'B' BINBYTES
        const n = buf.readUInt32LE(pos);
        pos += 4;
        stack.push(Buffer.from(buf.subarray(pos, pos + n)));
        pos += n;
        break;
      }
      case 0x55: { // 'U' SHORT_BINSTRING
        const n = buf[pos++];
        stack.push(buf.subarray(pos, pos + n).toString('latin1'));
        pos += n;
        break;
      }
      case 0x54: { // 'T' BINSTRING
        const n = buf.readUInt32LE(pos);
        pos += 4;
        stack.push(buf.subarray(pos, pos + n).toString('latin1'));
        pos += n;
        break;
      }
      case 0x71: { // 'q' BINPUT
        const idx = String(buf[pos++]);
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x72: { // 'r' LONG_BINPUT
        const idx = String(buf.readUInt32LE(pos));
        pos += 4;
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x70: { // 'p' PUT
        const idx = readLine();
        memo.set(idx, stack[stack.length - 1]);
        break;
      }
      case 0x94: { // MEMOIZE
        memo.set(String(memo.size), stack[stack.length - 1]);
        break;
      }
      case 0x68: { // 'h' BINGET
        const idx = String(buf[pos++]);
        stack.push(memo.get(idx));
        break;
      }
      case 0x6a: { // 'j' LONG_BINGET
        const idx = String(buf.readUInt32LE(pos));
        pos += 4;
        stack.push(memo.get(idx));
        break;
      }
      case 0x67: { // 'g' GET
        const idx = readLine();
        stack.push(memo.get(idx));
        break;
      }
      case 0x63: { // 'c' GLOBAL
        const mod = readLine();
        const name = readLine();
        if (mod === '_codecs' && name === 'encode') {
          stack.push({ __fn: 'codecs_encode' });
        } else if ((mod === '__builtin__' || mod === 'builtins') && name === 'bytes') {
          stack.push({ __fn: 'bytes' });
        } else {
          throw new ArchiveError(`无法解析 RPA 索引：refused ${mod}.${name}`);
        }
        break;
      }
      case 0x93: { // STACK_GLOBAL
        const name = String(stack.pop());
        const mod = String(stack.pop());
        if (mod === '_codecs' && name === 'encode') {
          stack.push({ __fn: 'codecs_encode' });
        } else if ((mod === '__builtin__' || mod === 'builtins') && name === 'bytes') {
          stack.push({ __fn: 'bytes' });
        } else {
          throw new ArchiveError(`无法解析 RPA 索引：refused ${mod}.${name}`);
        }
        break;
      }
      case 0x52: { // 'R' REDUCE
        const args = stack.pop() as unknown[];
        const fn = stack.pop() as { __fn?: string };
        if (fn?.__fn === 'codecs_encode' && Array.isArray(args) && typeof args[0] === 'string') {
          const enc = String(args[1] ?? 'latin-1').toLowerCase().replace('_', '-');
          if (enc === 'utf-8' || enc === 'utf8') stack.push(Buffer.from(args[0], 'utf8'));
          else if (enc === 'latin-1' || enc === 'latin1') stack.push(Buffer.from(args[0], 'latin1'));
          else throw new ArchiveError('refused codec');
        } else if (fn?.__fn === 'bytes' && Array.isArray(args)) {
          if (typeof args[0] === 'string') {
            stack.push(Buffer.from(args[0], String(args[1] ?? 'utf8') as BufferEncoding));
          } else {
            stack.push(Buffer.alloc(0));
          }
        } else {
          throw new ArchiveError('无法解析 RPA 索引 (refused REDUCE)');
        }
        break;
      }
      default:
        throw new ArchiveError(`无法解析 RPA 索引 (不支持的操作码 0x${op.toString(16)})`);
    }
  }

  const root = stack[0];
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new ArchiveError('RPA 索引不合法');
  }
  return root as Record<string, Array<[number, number, Buffer]>>;
}

function encodePickleRpaIndex(entries: Array<[string, bigint, bigint]>): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0x80, 0x02]), // PROTO 2
    Buffer.from('}', 'ascii'), // EMPTY_DICT
    Buffer.from('(', 'ascii'), // MARK
  ];
  const pushBigInt = (val: bigint) => {
    if (val >= 0n && val <= 255n) {
      parts.push(Buffer.from([0x4b, Number(val)])); // BININT1
    } else if (val >= 0n && val <= 65535n) {
      const b = Buffer.alloc(3);
      b[0] = 0x4d; // BININT2
      b.writeUInt16LE(Number(val), 1);
      parts.push(b);
    } else if (val >= -0x80000000n && val <= 0x7fffffffn) {
      const b = Buffer.alloc(5);
      b[0] = 0x4a; // BININT
      b.writeInt32LE(Number(val), 1);
      parts.push(b);
    } else {
      const bytes: number[] = [];
      let v = val;
      while (v > 0n) {
        bytes.push(Number(v & 0xffn));
        v >>= 8n;
      }
      if (bytes.length === 0) bytes.push(0);
      if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
      parts.push(Buffer.from([0x8a, bytes.length, ...bytes])); // LONG1
    }
  };

  for (const [name, offsetXor, lengthXor] of entries) {
    const rawName = Buffer.from(name, 'utf8');
    const hdr = Buffer.alloc(5);
    hdr[0] = 0x58; // BINUNICODE
    hdr.writeUInt32LE(rawName.length, 1);
    parts.push(hdr, rawName);
    parts.push(Buffer.from(']', 'ascii')); // EMPTY_LIST
    pushBigInt(offsetXor);
    pushBigInt(lengthXor);
    parts.push(Buffer.from([0x86, 0x61])); // TUPLE2 + APPEND
  }
  parts.push(Buffer.from('u.', 'ascii')); // SETITEMS + STOP
  return Buffer.concat(parts);
}

/* ========================= RPA ========================= */

function parseRpaHeaderText(head: Buffer, fileSize: number): { version: string; offset: number; key: number } | null {
  const firstNl = head.indexOf(0x0a);
  const lineBuf = firstNl >= 0 ? head.subarray(0, firstNl + 1) : head;
  const line = lineBuf.toString('latin1');
  const m = RPA_LINE_RE.exec(line);
  if (!m) return null;
  const version = m[1];
  const offset = Number.parseInt(m[2], 16);
  const key = version === '2.0' ? 0 : m[3] ? Number.parseInt(m[3], 16) : Number.NaN;
  if (!Number.isFinite(offset) || Number.isNaN(key) || offset <= 0 || offset >= fileSize || offset < lineBuf.length) {
    return null;
  }
  return { version, offset, key };
}

export function loadRpaIndex(archivePath: string, offset: number, key = 0): Array<[string, Array<[number, number, Buffer]>]> {
  const st = fs.statSync(archivePath);
  if (offset <= 0 || offset >= st.size) throw new ArchiveError('RPA 索引偏移无效');
  const readLen = Math.min(MAX_INDEX_BYTES + 1, st.size - offset);
  const blob = Buffer.alloc(readLen);
  const fd = fs.openSync(archivePath, 'r');
  try {
    fs.readSync(fd, blob, 0, readLen, offset);
  } finally {
    fs.closeSync(fd);
  }
  if (blob.length > MAX_INDEX_BYTES) throw new ArchiveError('RPA 索引超出上限');
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(blob, { maxOutputLength: MAX_INDEX_BYTES });
  } catch {
    throw new ArchiveError('无法解析 RPA 索引');
  }
  const loaded = decodePickle(raw);
  const keys = Object.keys(loaded);
  if (keys.length > MAX_ENTRIES) throw new ArchiveError('RPA 索引不合法');
  const keyBig = BigInt(key >>> 0);
  const entries: Array<[string, Array<[number, number, Buffer]>]> = [];
  for (const [rawName, segs] of Object.entries(loaded)) {
    const name = rawName.replace(/\\/g, '/');
    staysInside('.', name);
    if (!Array.isArray(segs) || segs.length === 0) throw new ArchiveError('RPA 条目分段不合法');
    const normSegs: Array<[number, number, Buffer]> = [];
    for (const seg of segs) {
      if (!Array.isArray(seg) || seg.length < 2) throw new ArchiveError('RPA 条目分段不合法');
      const segOff = Number(BigInt(seg[0] as unknown as number | bigint) ^ keyBig);
      const segLen = Number(BigInt(seg[1] as unknown as number | bigint) ^ keyBig);
      let prefix: Buffer = Buffer.alloc(0);
      if (seg.length > 2 && seg[2] !== undefined && seg[2] !== null) {
        if (Buffer.isBuffer(seg[2])) prefix = Buffer.from(seg[2]);
        else if (typeof seg[2] === 'string') prefix = Buffer.from(seg[2], 'latin1');
      }
      if (segOff < 0 || segLen < 0) throw new ArchiveError('RPA 条目分段不合法');
      normSegs.push([segOff, segLen, prefix]);
    }
    entries.push([name, normSegs]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
}

export function unpackRpa(archivePath: string, destDir: string): string[] {
  const st = fs.statSync(archivePath);
  const head = Buffer.alloc(Math.min(64, st.size));
  const fd = fs.openSync(archivePath, 'r');
  let entries: Array<[string, Array<[number, number, Buffer]>]>;
  let hdr: { version: string; offset: number; key: number } | null;
  try {
    fs.readSync(fd, head, 0, head.length, 0);
    hdr = parseRpaHeaderText(head, st.size);
    if (!hdr) throw new ArchiveError('不是有效的 RPA 封包');
    entries = loadRpaIndex(archivePath, hdr.offset, hdr.key);
    fs.mkdirSync(destDir, { recursive: true });
    const written: string[] = [];
    const filesMeta: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const [name, segs] of entries) {
      const chunks: Buffer[] = [];
      for (const [segOff, segLen, prefix] of segs) {
        if (prefix.length) chunks.push(prefix);
        if (segLen > 0) {
          const buf = Buffer.alloc(segLen);
          const n = fs.readSync(fd, buf, 0, segLen, segOff);
          if (n !== segLen) throw new ArchiveError('RPA 条目被截断');
          chunks.push(buf);
        }
      }
      const data = Buffer.concat(chunks);
      if (data.length > MAX_FILE_BYTES || total + data.length > MAX_TOTAL_BYTES) {
        throw new ArchiveError('解压体积超出上限');
      }
      const out = staysInside(destDir, name);
      if (isSymlinkPath(out)) throw new ArchiveError(`路径不合法：${name}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written.push(name);
      total += data.length;
      filesMeta.push({ name, size: data.length, sha256: sha256Hex(data) });
    }
    const raw = fs.readFileSync(archivePath);
    const manifest = {
      version: hdr.version,
      engine: 'renpy',
      key: hdr.key,
      index_offset: hdr.offset,
      source: realpathSafe(archivePath),
      archive_sha256: sha256Hex(raw),
      archive_size: raw.length,
      files: filesMeta,
    };
    fs.writeFileSync(path.join(destDir, RPA_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

export function repackRpa(sourceDir: string, destArchive: string): void {
  const manifestPath = path.join(sourceDir, RPA_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new ArchiveError('缺少有效的 RPA 清单');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const files = collectFilesFlat(sourceDir, RPA_MANIFEST);
  const expectedFiles = Array.isArray(manifest.files) ? (manifest.files as Array<Record<string, unknown>>) : [];
  for (const item of expectedFiles) {
    const p = staysInside(sourceDir, String(item.name));
    if (isSymlinkPath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new ArchiveError(`清单中的文件已缺失: ${item.name}`);
    }
  }
  const actualMap = new Map(files);
  const unchanged =
    expectedFiles.length === files.length &&
    expectedFiles.every((item) => {
      const d = actualMap.get(String(item.name));
      return d && d.length === Number(item.size) && sha256Hex(d) === item.sha256;
    });
  if (unchanged) {
    const original = String(manifest.source || '');
    if (original && !isSymlinkPath(original) && fs.existsSync(original)) {
      const origBuf = fs.readFileSync(original);
      if (origBuf.length === Number(manifest.archive_size) && sha256Hex(origBuf) === manifest.archive_sha256) {
        atomicWriteWithBackup(destArchive, origBuf);
        return;
      }
    }
  }

  const version = String(manifest.version || '3.0');
  const key = Number(manifest.key || 0) >>> 0;
  const xorKey = version === '2.0' ? 0n : BigInt(key);
  const rpaHeader = (offset: number) =>
    version === '2.0'
      ? Buffer.from(`RPA-2.0 ${offset.toString(16).padStart(16, '0')}\n`, 'ascii')
      : Buffer.from(`RPA-${version} ${offset.toString(16).padStart(16, '0')} ${key.toString(16).padStart(8, '0')}\n`, 'ascii');

  let cursor = rpaHeader(0).length;
  const indexEntries: Array<[string, bigint, bigint]> = [];
  const dataParts: Buffer[] = [];
  for (const [name, data] of files) {
    staysInside('.', name);
    indexEntries.push([name, BigInt(cursor) ^ xorKey, BigInt(data.length) ^ xorKey]);
    dataParts.push(data);
    cursor += data.length;
  }
  const indexBlob = zlib.deflateSync(encodePickleRpaIndex(indexEntries));
  const full = Buffer.concat([rpaHeader(cursor), ...dataParts, indexBlob]);
  atomicWriteWithBackup(destArchive, full);
}

/* ========================= XP3 ========================= */

export interface Xp3Segment {
  flags: number;
  offset: number;
  orig: number;
  packed: number;
}

export interface Xp3Entry {
  name: string;
  flags: number;
  origSize: number;
  packedSize: number;
  segments: Xp3Segment[];
  adler: number | null;
  directory: boolean;
}

export function parseXp3Header(head: Buffer, fileSize: number): { version: string; indexOffset: number } | null {
  if (head.length < 19 || !head.subarray(0, XP3_MAGIC.length).equals(XP3_MAGIC)) return null;
  const first = Number(head.readBigUInt64LE(11));
  let indexOffset: number;
  let version: string;
  let headerSize: number;
  if (first === 0x17) {
    if (head.length < 40 || head.readUInt32LE(23) !== 0x80) return null;
    indexOffset = Number(head.readBigUInt64LE(32));
    version = 'extra';
    headerSize = 40;
  } else {
    indexOffset = first;
    version = 'basic';
    headerSize = 19;
  }
  if (indexOffset < headerSize || indexOffset >= fileSize) return null;
  return { version, indexOffset };
}

function* iterXp3Chunks(data: Buffer): Generator<[string, Buffer]> {
  let pos = 0;
  while (pos + 12 <= data.length) {
    const magic = data.subarray(pos, pos + 4).toString('latin1');
    const size = Number(data.readBigUInt64LE(pos + 4));
    pos += 12;
    if (size < 0 || pos + size > data.length) throw new ArchiveError('XP3 索引块不合法');
    yield [magic, data.subarray(pos, pos + size)];
    pos += size;
  }
}

export function loadXp3Index(archivePath: string, offset: number): Xp3Entry[] {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const meta = Buffer.alloc(17);
    if (fs.readSync(fd, meta, 0, 17, offset) !== 17) throw new ArchiveError('XP3 索引被截断');
    const method = meta[0];
    const packed = Number(meta.readBigUInt64LE(1));
    const original = Number(meta.readBigUInt64LE(9));
    if ((method !== 0 && method !== 1) || packed <= 0 || packed > MAX_INDEX_BYTES || original > MAX_INDEX_BYTES) {
      throw new ArchiveError('XP3 索引超出上限');
    }
    const blob = Buffer.alloc(packed);
    if (fs.readSync(fd, blob, 0, packed, offset + 17) !== packed) throw new ArchiveError('XP3 索引被截断');
    const raw = method === 0 ? blob : zlib.inflateSync(blob, { maxOutputLength: MAX_INDEX_BYTES });
    if (raw.length !== original) throw new ArchiveError('XP3 索引大小不一致');

    const entries: Xp3Entry[] = [];
    let sawFile = false;
    for (const [magic, body] of iterXp3Chunks(raw)) {
      if (magic !== 'File') continue;
      sawFile = true;
      let info: { name: string; flags: number; orig: number; packed: number } | null = null;
      let segments: Xp3Segment[] = [];
      let adlerVal: number | null = null;
      for (const [cmagic, chunk] of iterXp3Chunks(body)) {
        if (cmagic === 'info') {
          if (chunk.length < 22) throw new ArchiveError('XP3 info 块不合法');
          const flags = chunk.readUInt32LE(0);
          const orig = Number(chunk.readBigUInt64LE(4));
          const psize = Number(chunk.readBigUInt64LE(12));
          const namelen = chunk.readUInt16LE(20);
          const nameBuf = chunk.subarray(22, 22 + namelen * 2);
          if (nameBuf.length !== namelen * 2) throw new ArchiveError('XP3 文件名不合法');
          const name = nameBuf.toString('utf16le').replace(/\\/g, '/');
          info = { name, flags, orig, packed: psize };
        } else if (cmagic === 'segm') {
          if (chunk.length < 28 || chunk.length % 28 !== 0) throw new ArchiveError('XP3 segm 块不合法');
          segments = [];
          for (let s = 0; s < chunk.length; s += 28) {
            segments.push({
              flags: chunk.readUInt32LE(s),
              offset: Number(chunk.readBigUInt64LE(s + 4)),
              orig: Number(chunk.readBigUInt64LE(s + 12)),
              packed: Number(chunk.readBigUInt64LE(s + 20)),
            });
          }
        } else if (cmagic === 'adlr' && chunk.length >= 4) {
          adlerVal = chunk.readUInt32LE(0);
        }
      }
      if (!info) throw new ArchiveError('XP3 File 块不完整');
      if (segments.length === 0) {
        entries.push({ name: info.name, flags: info.flags, origSize: info.orig, packedSize: info.packed, segments: [], adler: adlerVal, directory: true });
      } else {
        if (info.flags !== 0) throw new ArchiveError(`受保护的 XP3 条目：${info.name}`);
        staysInside('.', info.name);
        entries.push({ name: info.name, flags: info.flags, origSize: info.orig, packedSize: info.packed, segments, adler: adlerVal, directory: false });
      }
      if (entries.length > MAX_ENTRIES) throw new ArchiveError('XP3 索引不合法');
    }
    if (!sawFile) throw new ArchiveError('XP3 索引缺少 File 块');
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

export function unpackXp3(archivePath: string, destDir: string): string[] {
  const st = fs.statSync(archivePath);
  const head = Buffer.alloc(Math.min(64, st.size));
  const fd = fs.openSync(archivePath, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
    const parsed = parseXp3Header(head, st.size);
    if (!parsed) throw new ArchiveError('不是有效的 XP3 封包');
    const entries = loadXp3Index(archivePath, parsed.indexOffset);
    fs.mkdirSync(destDir, { recursive: true });
    const written: string[] = [];
    const filesMeta: Array<Record<string, unknown>> = [];
    const directories: string[] = [];
    let total = 0;

    for (const entry of entries) {
      if (entry.directory) {
        directories.push(entry.name);
        continue;
      }
      const chunks: Buffer[] = [];
      let expected = 0;
      const room = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
      for (const seg of entry.segments) {
        expected += seg.orig;
        if (expected > room) throw new ArchiveError('解压体积超出上限');
        const blob = Buffer.alloc(seg.packed);
        if (fs.readSync(fd, blob, 0, seg.packed, seg.offset) !== seg.packed) throw new ArchiveError('XP3 条目被截断');
        const raw = seg.flags & 1 ? zlib.inflateSync(blob, { maxOutputLength: Math.max(seg.orig, 1) }) : blob;
        if (raw.length !== seg.orig) throw new ArchiveError('XP3 分段大小不一致');
        chunks.push(raw);
      }
      const data = Buffer.concat(chunks);
      if (entry.adler !== null && adler32(data) !== entry.adler) throw new ArchiveError('XP3 校验和不匹配');
      if (data.length > MAX_FILE_BYTES || total + data.length > MAX_TOTAL_BYTES) throw new ArchiveError('解压体积超出上限');
      const out = staysInside(destDir, entry.name);
      if (isSymlinkPath(out)) throw new ArchiveError(`路径不合法：${entry.name}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written.push(entry.name);
      total += data.length;
      filesMeta.push({ name: entry.name, size: data.length, sha256: sha256Hex(data), verified: entry.adler !== null });
    }
    const raw = fs.readFileSync(archivePath);
    const manifest = {
      version: parsed.version,
      engine: 'kirikiri',
      index_offset: parsed.indexOffset,
      source: realpathSafe(archivePath),
      archive_sha256: sha256Hex(raw),
      archive_size: raw.length,
      files: filesMeta,
      directories,
    };
    fs.writeFileSync(path.join(destDir, XP3_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

export function repackXp3(sourceDir: string, destArchive: string): void {
  const manifestPath = path.join(sourceDir, XP3_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new ArchiveError('缺少有效的 XP3 清单');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const files = collectFilesFlat(sourceDir, XP3_MANIFEST);
  const expectedFiles = Array.isArray(manifest.files) ? (manifest.files as Array<Record<string, unknown>>) : [];
  for (const item of expectedFiles) {
    const p = staysInside(sourceDir, String(item.name));
    if (isSymlinkPath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new ArchiveError(`清单中的文件已缺失: ${item.name}`);
    }
  }
  const actualMap = new Map(files);
  const unchanged =
    expectedFiles.length === files.length &&
    expectedFiles.every((item) => {
      const d = actualMap.get(String(item.name));
      return d && d.length === Number(item.size) && sha256Hex(d) === item.sha256;
    });
  if (unchanged) {
    const original = String(manifest.source || '');
    if (original && !isSymlinkPath(original) && fs.existsSync(original)) {
      const origBuf = fs.readFileSync(original);
      if (origBuf.length === Number(manifest.archive_size) && sha256Hex(origBuf) === manifest.archive_sha256) {
        atomicWriteWithBackup(destArchive, origBuf);
        return;
      }
    }
  }

  const extra = String(manifest.version) === 'extra';
  const headerLen = extra ? 40 : 19;
  let cursor = headerLen;
  const payloads: Buffer[] = [];
  const fileChunks: Buffer[] = [];

  const mkChunk = (magic: string, body: Buffer): Buffer => {
    const hdr = Buffer.alloc(12);
    hdr.write(magic, 0, 4, 'latin1');
    hdr.writeBigUInt64LE(BigInt(body.length), 4);
    return Buffer.concat([hdr, body]);
  };

  for (const [name, data] of files) {
    staysInside('.', name);
    const packed = data;
    const encodedName = Buffer.from(name.replace(/\//g, '\\'), 'utf16le');
    const info = Buffer.alloc(22 + encodedName.length);
    info.writeUInt32LE(0, 0);
    info.writeBigUInt64LE(BigInt(data.length), 4);
    info.writeBigUInt64LE(BigInt(packed.length), 12);
    info.writeUInt16LE(encodedName.length / 2, 20);
    encodedName.copy(info, 22);

    const segm = Buffer.alloc(28);
    segm.writeUInt32LE(0, 0);
    segm.writeBigUInt64LE(BigInt(cursor), 4);
    segm.writeBigUInt64LE(BigInt(data.length), 12);
    segm.writeBigUInt64LE(BigInt(packed.length), 20);

    const adlr = Buffer.alloc(4);
    adlr.writeUInt32LE(adler32(data), 0);

    fileChunks.push(mkChunk('File', Buffer.concat([mkChunk('info', info), mkChunk('segm', segm), mkChunk('adlr', adlr)])));
    payloads.push(packed);
    cursor += packed.length;
  }

  const indexBody = Buffer.concat(fileChunks);
  const indexPacked = zlib.deflateSync(indexBody);
  const indexMeta = Buffer.alloc(17);
  indexMeta[0] = 1;
  indexMeta.writeBigUInt64LE(BigInt(indexPacked.length), 1);
  indexMeta.writeBigUInt64LE(BigInt(indexBody.length), 9);

  let headerBuf: Buffer;
  if (extra) {
    headerBuf = Buffer.alloc(40);
    XP3_MAGIC.copy(headerBuf, 0);
    headerBuf.writeBigUInt64LE(0x17n, 11);
    headerBuf.writeUInt32LE(1, 19);
    headerBuf.writeUInt32LE(0x80, 23);
    headerBuf.writeBigUInt64LE(BigInt(cursor), 32);
  } else {
    headerBuf = Buffer.alloc(19);
    XP3_MAGIC.copy(headerBuf, 0);
    headerBuf.writeBigUInt64LE(BigInt(cursor), 11);
  }
  atomicWriteWithBackup(destArchive, Buffer.concat([headerBuf, ...payloads, indexMeta, indexPacked]));
}

/* ========================= PE+ZIP ========================= */

interface ZipCdEntry {
  name: string;
  isDir: boolean;
  flagBits: number;
  compressType: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttr: number;
  createSystem: number;
  localHeaderOffset: number;
  extra: Buffer;
  comment: Buffer;
}

export interface PeZipIndex {
  zipOffset: number;
  engine: string;
  entries: ZipCdEntry[];
  comment: Buffer;
}

function readZipEntryData(fd: number, zipOffset: number, entry: ZipCdEntry): Buffer {
  const lfh = Buffer.alloc(30);
  if (fs.readSync(fd, lfh, 0, 30, zipOffset + entry.localHeaderOffset) !== 30 || lfh.readUInt32LE(0) !== 0x04034b50) {
    throw new ArchiveError(`无法解析 ZIP 本地文件头：${entry.name}`);
  }
  const fnameLen = lfh.readUInt16LE(26);
  const extraLen = lfh.readUInt16LE(28);
  const dataOffset = zipOffset + entry.localHeaderOffset + 30 + fnameLen + extraLen;
  const compBuf = Buffer.alloc(entry.compressedSize);
  if (entry.compressedSize > 0 && fs.readSync(fd, compBuf, 0, entry.compressedSize, dataOffset) !== entry.compressedSize) {
    throw new ArchiveError(`ZIP 条目被截断：${entry.name}`);
  }
  let data: Buffer;
  if (entry.compressType === 0) {
    data = compBuf;
  } else if (entry.compressType === 8) {
    data = zlib.inflateRawSync(compBuf, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
  } else {
    throw new ArchiveError(`不支持的 ZIP 压缩方法 ${entry.compressType}：${entry.name}`);
  }
  if (data.length !== entry.uncompressedSize) {
    throw new ArchiveError(`解压体积不一致：${entry.name}`);
  }
  return data;
}

export function inspectPeZip(archivePath: string): PeZipIndex {
  const st = fs.statSync(archivePath);
  const size = st.size;
  const fd = fs.openSync(archivePath, 'r');
  try {
    const mz = Buffer.alloc(2);
    if (size < 22 || fs.readSync(fd, mz, 0, 2, 0) !== 2 || mz.toString('ascii') !== 'MZ') {
      throw new ArchiveError('不是 PE+ZIP 封包');
    }
    const tailLen = Math.min(size, 22 + 65535);
    const tailStart = size - tailLen;
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, tailStart);

    const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let pos = tail.lastIndexOf(sig);
    let foundEocd: { zipOffset: number; count: number; cdSize: number; cdAbsOffset: number; comment: Buffer } | null = null;
    while (pos >= 0) {
      if (pos + 22 <= tail.length) {
        const disk = tail.readUInt16LE(pos + 4);
        const cdDisk = tail.readUInt16LE(pos + 6);
        const onDisk = tail.readUInt16LE(pos + 8);
        const count = tail.readUInt16LE(pos + 10);
        const cdSize = tail.readUInt32LE(pos + 12);
        const cdOffset = tail.readUInt32LE(pos + 16);
        const commentLen = tail.readUInt16LE(pos + 20);
        const absolute = tailStart + pos;
        if (
          disk === 0 &&
          cdDisk === 0 &&
          onDisk === count &&
          count !== 0xffff &&
          cdSize !== 0xffffffff &&
          cdOffset !== 0xffffffff &&
          cdSize <= MAX_INDEX_BYTES &&
          absolute + 22 + commentLen === size
        ) {
          const zipOffset = absolute - cdSize - cdOffset;
          if (zipOffset >= 2 && zipOffset < absolute) {
            const comment = Buffer.from(tail.subarray(pos + 22, pos + 22 + commentLen));
            foundEocd = { zipOffset, count, cdSize, cdAbsOffset: zipOffset + cdOffset, comment };
            break;
          }
        }
      }
      pos = pos === 0 ? -1 : tail.lastIndexOf(sig, pos - 1);
    }
    if (!foundEocd) throw new ArchiveError('PE 尾部没有有效 ZIP 目录');

    const cdBuf = Buffer.alloc(foundEocd.cdSize);
    if (fs.readSync(fd, cdBuf, 0, foundEocd.cdSize, foundEocd.cdAbsOffset) !== foundEocd.cdSize) {
      throw new ArchiveError('无法读取 ZIP 中央目录');
    }

    const entries: ZipCdEntry[] = [];
    const seen = new Set<string>();
    let cdPos = 0;
    while (cdPos + 46 <= cdBuf.length) {
      if (cdBuf.readUInt32LE(cdPos) !== 0x02014b50) throw new ArchiveError('ZIP 中央目录格式无效');
      const versionMadeBy = cdBuf.readUInt16LE(cdPos + 4);
      const flagBits = cdBuf.readUInt16LE(cdPos + 8);
      const compressType = cdBuf.readUInt16LE(cdPos + 10);
      const dosTime = cdBuf.readUInt16LE(cdPos + 12);
      const dosDate = cdBuf.readUInt16LE(cdPos + 14);
      const crc = cdBuf.readUInt32LE(cdPos + 16);
      const compressedSize = cdBuf.readUInt32LE(cdPos + 20);
      const uncompressedSize = cdBuf.readUInt32LE(cdPos + 24);
      const nameLen = cdBuf.readUInt16LE(cdPos + 28);
      const extraLen = cdBuf.readUInt16LE(cdPos + 30);
      const commentLen = cdBuf.readUInt16LE(cdPos + 32);
      const externalAttr = cdBuf.readUInt32LE(cdPos + 38);
      const localHeaderOffset = cdBuf.readUInt32LE(cdPos + 42);
      const rawName = cdBuf.subarray(cdPos + 46, cdPos + 46 + nameLen).toString(flagBits & 0x800 ? 'utf8' : 'latin1');
      const extra = Buffer.from(cdBuf.subarray(cdPos + 46 + nameLen, cdPos + 46 + nameLen + extraLen));
      const comment = Buffer.from(cdBuf.subarray(cdPos + 46 + nameLen + extraLen, cdPos + 46 + nameLen + extraLen + commentLen));
      cdPos += 46 + nameLen + extraLen + commentLen;

      const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
      const normName = rawName.replace(/\\/g, '/').trim().replace(/\/+$/, '');
      staysInside('.', normName);
      const unixMode = (externalAttr >>> 16) & 0o170000;
      if (unixMode === 0o120000) throw new ArchiveError(`符号链接条目不支持：${normName}`);
      const key = normName.toLowerCase();
      if (seen.has(key)) throw new ArchiveError(`重复条目不支持：${normName}`);
      seen.add(key);

      entries.push({
        name: normName,
        isDir,
        flagBits,
        compressType,
        dosTime,
        dosDate,
        crc,
        compressedSize,
        uncompressedSize,
        externalAttr,
        createSystem: versionMadeBy >>> 8,
        localHeaderOffset,
        extra,
        comment,
      });
    }
    if (!entries.length || entries.length > MAX_ENTRIES) throw new ArchiveError('PE+ZIP 条目数量不合法');

    let engine = 'pe-zip';
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    if ([...names].some((n) => n === 'tyrano/tyrano.js' || n.endsWith('/config.tjs'))) {
      engine = 'tyrano';
    } else if (names.has('package.json')) {
      const pkg = entries.find((e) => e.name.toLowerCase() === 'package.json');
      if (pkg && pkg.uncompressedSize <= 1024 * 1024) {
        try {
          const pkgBuf = readZipEntryData(fd, foundEocd.zipOffset, pkg);
          if (pkgBuf.includes('app://')) engine = 'tyrano';
        } catch {
          // ignore
        }
      }
    }
    return { zipOffset: foundEocd.zipOffset, engine, entries, comment: foundEocd.comment };
  } finally {
    fs.closeSync(fd);
  }
}

export function unpackPeZip(archivePath: string, destDir: string): string[] {
  const idx = inspectPeZip(archivePath);
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(archivePath, 'r');
  try {
    const written: string[] = [];
    const filesMeta: Array<Record<string, unknown>> = [];
    const directories: string[] = [];
    let total = 0;
    for (const entry of idx.entries) {
      if (entry.isDir) {
        directories.push(entry.name);
        continue;
      }
      if (entry.flagBits & 1) throw new ArchiveError(`加密条目不支持：${entry.name}`);
      const room = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
      if (entry.uncompressedSize > room) throw new ArchiveError('解压体积超出上限');
      const data = readZipEntryData(fd, idx.zipOffset, entry);
      if (data.length > room) throw new ArchiveError('解压体积超出上限');
      const out = staysInside(destDir, entry.name);
      if (isSymlinkPath(out)) throw new ArchiveError(`路径不合法：${entry.name}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written.push(entry.name);
      total += data.length;
      filesMeta.push({
        name: entry.name,
        size: data.length,
        sha256: sha256Hex(data),
        compress_type: entry.compressType,
        dos_time: entry.dosTime,
        dos_date: entry.dosDate,
        external_attr: entry.externalAttr,
        create_system: entry.createSystem,
        comment: entry.comment.toString('hex'),
        extra: entry.extra.toString('hex'),
      });
    }
    const raw = fs.readFileSync(archivePath);
    const manifest = {
      version: 'pe-zip',
      engine: idx.engine,
      zip_offset: idx.zipOffset,
      source: realpathSafe(archivePath),
      archive_sha256: sha256Hex(raw),
      archive_size: raw.length,
      archive_comment: idx.comment.toString('hex'),
      files: filesMeta,
      directories,
    };
    fs.writeFileSync(path.join(destDir, PEZIP_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

export function repackPeZip(sourceDir: string, destArchive: string): void {
  const manifestPath = path.join(sourceDir, PEZIP_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new ArchiveError('缺少有效的 PE+ZIP 清单');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const original = String(manifest.source || '');
  if (!original || isSymlinkPath(original) || !fs.existsSync(original)) {
    throw new ArchiveError('原 PE+ZIP 封包不存在，无法保留 PE 前缀');
  }
  if (realpathSafe(original) === realpathSafe(destArchive)) {
    throw new ArchiveError('拒绝覆盖原 PE+ZIP 封包');
  }
  const origData = fs.readFileSync(original);
  if (origData.length !== Number(manifest.archive_size) || sha256Hex(origData) !== manifest.archive_sha256) {
    throw new ArchiveError('原 PE+ZIP 封包已变化，拒绝使用它的 PE 前缀');
  }
  const files = collectFilesFlat(sourceDir, PEZIP_MANIFEST);
  const expectedFiles = Array.isArray(manifest.files) ? (manifest.files as Array<Record<string, unknown>>) : [];
  for (const item of expectedFiles) {
    const p = staysInside(sourceDir, String(item.name));
    if (isSymlinkPath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new ArchiveError(`清单中的文件已缺失：${item.name}`);
    }
  }
  const actualMap = new Map(files);
  const unchanged =
    expectedFiles.length === files.length &&
    expectedFiles.every((item) => {
      const d = actualMap.get(String(item.name));
      return d && d.length === Number(item.size) && sha256Hex(d) === item.sha256;
    });
  if (unchanged) {
    atomicWriteWithBackup(destArchive, origData);
    return;
  }

  const offset = Number(manifest.zip_offset);
  if (!Number.isInteger(offset) || offset < 2 || offset > origData.length || origData.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new ArchiveError('清单中的 PE 前缀偏移无效');
  }

  const listed = expectedFiles.map((f) => String(f.name));
  const listedSet = new Set(listed);
  const orderedNames = [...listed, ...files.map(([n]) => n).filter((n) => !listedSet.has(n)).sort()];
  const metaMap = new Map(expectedFiles.map((f) => [String(f.name), f]));

  const lfhChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let localOffset = 0;

  for (const name of orderedNames) {
    const data = actualMap.get(name)!;
    const rec = metaMap.get(name);
    const compressType = rec && Number(rec.compress_type) === 0 ? 0 : 8;
    const compressed = compressType === 0 ? data : zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const flagBits = 0x800; // UTF-8
    const dosTime = rec && typeof rec.dos_time === 'number' ? rec.dos_time : 0;
    const dosDate = rec && typeof rec.dos_date === 'number' ? rec.dos_date : 0x0021;
    const extAttr = rec && typeof rec.external_attr === 'number' ? rec.external_attr : 0;
    const createSys = rec && typeof rec.create_system === 'number' ? rec.create_system : 3;
    const extra = rec && typeof rec.extra === 'string' && rec.extra ? Buffer.from(rec.extra, 'hex') : Buffer.alloc(0);
    const comment = rec && typeof rec.comment === 'string' && rec.comment ? Buffer.from(rec.comment, 'hex') : Buffer.alloc(0);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(flagBits, 6);
    lfh.writeUInt16LE(compressType, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    lfhChunks.push(lfh, nameBuf, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((createSys << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flagBits, 8);
    cd.writeUInt16LE(compressType, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt16LE(comment.length, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(extAttr >>> 0, 38);
    cd.writeUInt32LE(localOffset >>> 0, 42);
    cdChunks.push(cd, nameBuf, extra, comment);

    localOffset += lfh.length + nameBuf.length + compressed.length;
  }

  const cdBlob = Buffer.concat(cdChunks);
  const archiveComment = typeof manifest.archive_comment === 'string' && manifest.archive_comment
    ? Buffer.from(manifest.archive_comment, 'hex')
    : Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(orderedNames.length, 8);
  eocd.writeUInt16LE(orderedNames.length, 10);
  eocd.writeUInt32LE(cdBlob.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(archiveComment.length, 20);

  const combined = Buffer.concat([origData.subarray(0, offset), ...lfhChunks, cdBlob, eocd, archiveComment]);
  atomicWriteWithBackup(destArchive, combined);
}

/* ========================= NSA ========================= */

export interface NsaEntry {
  name: string;
  nameBytes: Buffer;
  compression: number;
  offset: number;
  packed: number;
  original: number;
}

export interface NsaIndex {
  baseOffset: number;
  entries: NsaEntry[];
}

class NsaBitReader {
  private pos = 0;
  private buf = 0;
  private mask = 0;
  constructor(private readonly data: Buffer) {}
  get(count: number): number | null {
    let val = 0;
    for (let i = 0; i < count; i++) {
      if (this.mask === 0) {
        if (this.pos >= this.data.length) return null;
        this.buf = this.data[this.pos++];
        this.mask = 128;
      }
      val = (val << 1) | (this.buf & this.mask ? 1 : 0);
      this.mask >>= 1;
    }
    return val;
  }
  require(count: number): number {
    const v = this.get(count);
    if (v === null) throw new ArchiveError('SPB 数据被截断');
    return v;
  }
}

export function loadNsaIndex(archivePath: string): NsaIndex {
  const st = fs.statSync(archivePath);
  const fd = fs.openSync(archivePath, 'r');
  try {
    const hdr = Buffer.alloc(6);
    if (fs.readSync(fd, hdr, 0, 6, 0) < 6) throw new ArchiveError('不是有效的 NSA 封包');
    const count = hdr.readUInt16BE(0);
    const base = hdr.readUInt32BE(2);
    if (count <= 0 || count > 65535) throw new ArchiveError('NSA 条目数量不合法');
    const min = 6 + 15 * count;
    if (base < min || base > st.size || base > MAX_INDEX_BYTES) throw new ArchiveError('NSA 索引偏移无效');
    const blob = Buffer.alloc(base - 6);
    if (fs.readSync(fd, blob, 0, blob.length, 6) !== blob.length) throw new ArchiveError('NSA 索引被截断');

    const entries: NsaEntry[] = [];
    const seen = new Set<string>();
    let pos = 0;
    for (let i = 0; i < count; i++) {
      const end = blob.indexOf(0x00, pos);
      if (end <= pos) throw new ArchiveError('NSA 索引不合法');
      const rawName = Buffer.from(blob.subarray(pos, end));
      if (rawName.length > 255) throw new ArchiveError('NSA 文件名过长');
      pos = end + 1;
      if (pos + 13 > blob.length) throw new ArchiveError('NSA 索引被截断');
      const compression = blob[pos];
      const relative = blob.readUInt32BE(pos + 1);
      const packed = blob.readUInt32BE(pos + 5);
      const original = blob.readUInt32BE(pos + 9);
      pos += 13;
      if (![0, 1, 2, 4].includes(compression)) throw new ArchiveError(`不支持的 NSA 压缩类型：${compression}`);
      const offset = base + relative;
      if (offset < base || packed > st.size || offset > st.size - packed) throw new ArchiveError('NSA 条目超出封包');
      const name = decodeCp932Bytes(rawName).replace(/\\/g, '/');
      staysInside('.', name);
      const key = name.toLowerCase();
      if (seen.has(key)) throw new ArchiveError(`重复条目不支持：${name}`);
      seen.add(key);
      entries.push({ name, nameBytes: rawName, compression, offset, packed, original });
    }
    if (pos !== blob.length) throw new ArchiveError('NSA 索引长度不一致');
    return { baseOffset: base, entries };
  } finally {
    fs.closeSync(fd);
  }
}

function decodeNsaLzss(data: Buffer, expected: number): Buffer {
  if (expected <= 0) throw new ArchiveError('LZSS 长度不合法');
  const reader = new NsaBitReader(data);
  const window = Buffer.alloc(256);
  let ring = 256 - 17;
  const out: number[] = [];
  while (out.length < expected) {
    const flag = reader.get(1);
    if (flag === null) break;
    if (flag) {
      const val = reader.get(8);
      if (val === null) break;
      window[ring] = val;
      ring = (ring + 1) & 255;
      out.push(val);
      continue;
    }
    const position = reader.get(8);
    const length = reader.get(4);
    if (position === null || length === null) break;
    for (let o = 0; o < length + 2; o++) {
      if (out.length >= expected) break;
      const val = window[(position + o) & 255];
      window[ring] = val;
      ring = (ring + 1) & 255;
      out.push(val);
    }
  }
  if (out.length !== expected) throw new ArchiveError('LZSS 长度不一致');
  return Buffer.from(out);
}

function decodeNsaSpb(payload: Buffer, limit: number): Buffer {
  if (payload.length < 4) throw new ArchiveError('SPB 数据被截断');
  const width = payload.readUInt16BE(0);
  const height = payload.readUInt16BE(2);
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new ArchiveError('SPB 尺寸不合法');
  const pixels = width * height;
  const stride = width * 3 + ((4 - ((width * 3) % 4)) % 4);
  const total = stride * height + 54;
  if (total > limit || pixels * 4 > limit) throw new ArchiveError('解压体积超出上限');
  const reader = new NsaBitReader(payload.subarray(4));
  const image = Buffer.alloc(total);
  image[0] = 0x42;
  image[1] = 0x4d;
  image.writeUInt32LE(total, 2);
  image[10] = 54;
  image[14] = 40;
  image.writeUInt16LE(width, 18);
  image.writeUInt16LE(height, 22);
  image[26] = 1;
  image[28] = 24;

  for (let ch = 0; ch < 3; ch++) {
    const plane = Buffer.alloc(pixels + 4);
    let count = 0;
    let color = reader.require(8);
    plane[count++] = color;
    while (count < pixels) {
      const run = reader.require(3);
      if (run === 0) {
        plane.fill(color, count, count + 4);
        count += 4;
        continue;
      }
      const widthBits = run === 7 ? reader.require(1) + 1 : run + 2;
      for (let k = 0; k < 4; k++) {
        if (widthBits === 8) {
          color = reader.require(8);
        } else {
          const delta = reader.require(widthBits);
          if (delta & 1) color = (color + (delta >> 1) + 1) & 0xff;
          else color = (color - (delta >> 1)) & 0xff;
        }
        if (count < plane.length) plane[count] = color;
        count += 1;
      }
    }
    let cursor = stride * (height - 1) + ch + 54;
    let src = 0;
    for (let row = 0; row < height; row++) {
      if (row & 1) {
        for (let col = 0; col < width; col++) {
          if (cursor < 0 || cursor >= image.length) throw new ArchiveError('SPB 数据不合法');
          image[cursor] = plane[src++];
          cursor -= 3;
        }
        cursor -= stride - 3;
      } else {
        for (let col = 0; col < width; col++) {
          if (cursor < 0 || cursor >= image.length) throw new ArchiveError('SPB 数据不合法');
          image[cursor] = plane[src++];
          cursor += 3;
        }
        cursor -= stride + 3;
      }
    }
  }
  return image;
}

export function unpackNsa(archivePath: string, destDir: string): string[] {
  const index = loadNsaIndex(archivePath);
  fs.mkdirSync(destDir, { recursive: true });
  const fd = fs.openSync(archivePath, 'r');
  try {
    const written: string[] = [];
    const filesMeta: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const entry of index.entries) {
      const raw = Buffer.alloc(entry.packed);
      if (entry.packed > 0 && fs.readSync(fd, raw, 0, entry.packed, entry.offset) !== entry.packed) {
        throw new ArchiveError('NSA 条目被截断');
      }
      let data: Buffer;
      if (entry.compression === 0) {
        if (entry.packed > MAX_FILE_BYTES) throw new ArchiveError('解压体积超出上限');
        data = raw;
      } else if (entry.compression === 2) {
        if (entry.original <= 0 || entry.original > MAX_FILE_BYTES) throw new ArchiveError('解压体积超出上限');
        data = decodeNsaLzss(raw, entry.original);
      } else if (entry.compression === 1) {
        data = decodeNsaSpb(raw, MAX_FILE_BYTES);
      } else {
        throw new ArchiveError('暂不支持 NBZ (bzip2) 压缩条目；可通过 reverser 脚本解包。');
      }
      if (data.length > MAX_FILE_BYTES || total + data.length > MAX_TOTAL_BYTES) {
        throw new ArchiveError('解压体积超出上限');
      }
      const out = staysInside(destDir, entry.name);
      if (isSymlinkPath(out)) throw new ArchiveError(`路径不合法：${entry.name}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
      written.push(entry.name);
      total += data.length;
      filesMeta.push({
        name: entry.name,
        name_bytes: entry.nameBytes.toString('hex'),
        size: data.length,
        sha256: sha256Hex(data),
        compression: entry.compression,
      });
    }
    const rawArchive = fs.readFileSync(archivePath);
    const manifest = {
      version: 'nsa',
      engine: 'nscripter',
      source: realpathSafe(archivePath),
      archive_sha256: sha256Hex(rawArchive),
      archive_size: rawArchive.length,
      files: filesMeta,
    };
    fs.writeFileSync(path.join(destDir, NSA_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return written;
  } finally {
    fs.closeSync(fd);
  }
}

export function repackNsa(sourceDir: string, destArchive: string): void {
  const manifestPath = path.join(sourceDir, NSA_MANIFEST);
  if (!fs.existsSync(manifestPath)) throw new ArchiveError('缺少有效的 NSA 清单');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const original = String(manifest.source || '');
  if (realpathSafe(original) === realpathSafe(destArchive)) throw new ArchiveError('拒绝覆盖原 NSA 封包');
  const files = collectFilesFlat(sourceDir, NSA_MANIFEST);
  const expectedFiles = Array.isArray(manifest.files) ? (manifest.files as Array<Record<string, unknown>>) : [];
  for (const item of expectedFiles) {
    const p = staysInside(sourceDir, String(item.name));
    if (isSymlinkPath(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
      throw new ArchiveError(`清单中的文件已缺失：${item.name}`);
    }
  }
  const actualMap = new Map(files);
  const unchanged =
    expectedFiles.length === files.length &&
    expectedFiles.every((item) => {
      const d = actualMap.get(String(item.name));
      return d && d.length === Number(item.size) && sha256Hex(d) === item.sha256;
    });
  if (unchanged && original && !isSymlinkPath(original) && fs.existsSync(original)) {
    const origData = fs.readFileSync(original);
    if (origData.length === Number(manifest.archive_size) && sha256Hex(origData) === manifest.archive_sha256) {
      atomicWriteWithBackup(destArchive, origData);
      return;
    }
  }

  const listed = expectedFiles.map((f) => String(f.name));
  const listedSet = new Set(listed);
  const orderedNames = [...listed, ...files.map(([n]) => n).filter((n) => !listedSet.has(n)).sort()];
  const metaMap = new Map(expectedFiles.map((f) => [String(f.name), f]));
  const indexParts: Buffer[] = [];
  const payloads: Buffer[] = [];
  let cursor = 0;

  for (const name of orderedNames) {
    const data = actualMap.get(name)!;
    const rec = metaMap.get(name);
    let rawName: Buffer;
    if (rec && typeof rec.name_bytes === 'string' && rec.name_bytes) {
      rawName = Buffer.from(rec.name_bytes, 'hex');
    } else {
      rawName = encodeCp932Bytes(name);
    }
    const entryMeta = Buffer.alloc(14);
    entryMeta[0] = 0;
    entryMeta[1] = 0; // STORED
    entryMeta.writeUInt32BE(cursor, 2);
    entryMeta.writeUInt32BE(data.length, 6);
    entryMeta.writeUInt32BE(data.length, 10);
    indexParts.push(rawName, entryMeta);
    payloads.push(data);
    cursor += data.length;
  }
  const indexBlob = Buffer.concat(indexParts);
  const base = 6 + indexBlob.length;
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16BE(orderedNames.length, 0);
  hdr.writeUInt32BE(base, 2);
  atomicWriteWithBackup(destArchive, Buffer.concat([hdr, indexBlob, ...payloads]));
}

/* ========================= Engine Profiles, Matchers & Scanner ========================= */

export interface EngineMatcher {
  engine: string;
  kind: string;
  extensions: string[];
  magicBytes: Buffer;
  magicOffset: number;
}

export interface ArchiveHit {
  engine: string;
  path: string;
  kind: string;
  version: string;
  extra: Record<string, string | number>;
}

export interface UnknownFile {
  path: string;
  size: number;
  suffix: string;
  head: string;
  reason: string;
}

export interface ScanResult {
  hits: ArchiveHit[];
  unknown: UnknownFile[];
  unknownTotal: number;
  engines: string[];
}

export interface SkillBinding {
  state: 'ready' | 'mismatch' | 'absent';
  directory?: string;
}

export function isEngineName(name: string): boolean {
  return ENGINE_NAME_RE.test(name.trim());
}

export function globalEnginesDir(homeDir: string): string {
  return path.join(homeDir, 'engines');
}

export function listGlobalEngines(homeDir: string | null): string[] {
  if (!homeDir) return [];
  const root = globalEnginesDir(homeDir);
  if (isSymlinkPath(root) || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !isSymlinkPath(path.join(root, d.name)) && isEngineName(d.name))
    .map((d) => d.name)
    .sort();
}

export function loadEngineProfile(homeDir: string | null, name: string): Record<string, unknown> | null {
  if (!homeDir || !isEngineName(name)) return null;
  const p = path.join(globalEnginesDir(homeDir), name, 'engine.json');
  try {
    if (isSymlinkPath(p) || !fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 32 * 1024) return null;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { name, ...(parsed as Record<string, unknown>) };
  } catch {
    return null;
  }
}

export function profileSkill(profile: Record<string, unknown> | null): string {
  const val = profile?.[SKILL_POINTER];
  if (typeof val !== 'string') return '';
  const name = val.trim();
  return isEngineName(name) ? name : '';
}

export function profileSkillDigest(profile: Record<string, unknown> | null): string {
  const val = profile?.[SKILL_DIGEST];
  if (typeof val !== 'string') return '';
  const digest = val.trim().toLowerCase();
  return SHA256_RE.test(digest) ? digest : '';
}

export function parseEngineMatcher(profile: Record<string, unknown> | null): EngineMatcher | null {
  if (!profile) return null;
  const name = String(profile.name || '').trim().toLowerCase();
  if (!name || !isEngineName(name) || RESERVED_CUSTOM_ENGINES.has(name)) return null;
  const pipeline = String(profile.pipeline || '').trim().toLowerCase();
  if (pipeline === 'builtin') return null;
  const rawMatch = profile.match;
  if (!rawMatch || typeof rawMatch !== 'object' || Array.isArray(rawMatch)) return null;
  const m = rawMatch as Record<string, unknown>;
  const extensions: string[] = [];
  if (Array.isArray(m.extensions)) {
    for (const item of m.extensions) {
      if (typeof item !== 'string') return null;
      const ext = item.trim().toLowerCase();
      if (!ext.startsWith('.') || ext === '.' || ext === '..' || /[/\\ ]/.test(ext)) return null;
      if (!extensions.includes(ext)) extensions.push(ext);
    }
  }
  let magicBytes = Buffer.alloc(0);
  if (typeof m.magic_hex === 'string' && m.magic_hex.trim()) {
    const hex = m.magic_hex.trim().toLowerCase();
    if (hex.length % 2 !== 0 || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) return null;
    magicBytes = Buffer.from(hex, 'hex');
  }
  const offset = typeof m.magic_offset === 'number' && Number.isInteger(m.magic_offset) ? m.magic_offset : 0;
  if (offset < 0 || offset > 4096) return null;
  if (extensions.length === 0 && magicBytes.length === 0) return null;
  if (magicBytes.length === 0 && extensions.length > 0 && extensions.every((e) => e === '.exe')) return null;

  let kind = 'custom';
  if (Array.isArray(profile.kinds)) {
    for (const item of profile.kinds) {
      if (typeof item === 'string' && isEngineName(item.trim().toLowerCase())) {
        kind = item.trim().toLowerCase();
        break;
      }
    }
  }
  if (BUILTIN_ARCHIVE_KINDS.has(kind) || NO_UNPACKER_KINDS.has(kind)) return null;
  return { engine: name, kind, extensions, magicBytes, magicOffset: offset };
}

export function loadCustomMatchers(homeDir: string | null): EngineMatcher[] {
  const names = listGlobalEngines(homeDir);
  const found: EngineMatcher[] = [];
  for (const name of names) {
    const data = loadEngineProfile(homeDir, name);
    const matcher = parseEngineMatcher(data);
    if (matcher) found.push(matcher);
  }
  return found;
}

function readAt(filePath: string, offset: number, count: number): Buffer | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(count);
      const n = fs.readSync(fd, buf, 0, count, offset);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function looksBinary(head: Buffer): boolean {
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b < 9 || (b > 13 && b < 32) || b === 127) return true;
  }
  return false;
}

function looksText(head: Buffer): boolean {
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (!(b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) return false;
  }
  return true;
}

function unknownHead(head: Buffer): string {
  const sample = head.subarray(0, 4);
  if (!sample.length || looksText(sample)) return '';
  return sample.toString('hex');
}

function ruleMatchesFile(filePath: string, suffix: string, head: Buffer, rule: EngineMatcher): boolean {
  if (rule.extensions.length && !rule.extensions.includes(suffix)) return false;
  if (rule.magicBytes.length) {
    if (rule.magicOffset === 0 && head.length >= rule.magicBytes.length) {
      return head.subarray(0, rule.magicBytes.length).equals(rule.magicBytes);
    }
    const sample = readAt(filePath, rule.magicOffset, rule.magicBytes.length);
    return sample ? sample.equals(rule.magicBytes) : false;
  }
  return rule.extensions.length > 0;
}

function siblingFileExists(filePath: string, targetLower: string): boolean {
  try {
    const dir = path.dirname(filePath);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === targetLower && !isSymlinkPath(path.join(dir, entry.name)) && entry.isFile()) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function classifyFile(root: string, filePath: string, matchers: EngineMatcher[]): ArchiveHit | UnknownFile | null {
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === '.bak') return null;
  const head = readAt(filePath, 0, 64);
  if (!head || head.length === 0) return null;
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return null;
  }
  const rel = path.relative(root, filePath).replace(/\\/g, '/');

  const rpa = parseRpaHeaderText(head, size);
  if (rpa && rpa.offset < size) {
    return { engine: 'renpy', path: rel, kind: 'rpa', version: rpa.version, extra: rpa };
  }
  const xp3 = parseXp3Header(head, size);
  if (xp3 && xp3.indexOffset >= 19 && xp3.indexOffset < size) {
    return { engine: 'kirikiri', path: rel, kind: 'xp3', version: xp3.version, extra: { index_offset: xp3.indexOffset } };
  }
  if (suffix === '.exe' && head.subarray(0, 2).toString('ascii') === 'MZ') {
    try {
      const idx = inspectPeZip(filePath);
      return { engine: idx.engine, path: rel, kind: 'pe-zip', version: '', extra: { zip_offset: idx.zipOffset } };
    } catch {
      // Fall through: regular PE binary
    }
  }
  if (head.subarray(0, 7).toString('ascii') === 'UnityFS') {
    return { engine: 'unity', path: rel, kind: 'unityfs', version: '', extra: {} };
  }
  if (suffix === '.int' && head.subarray(0, 4).equals(Buffer.from([0x4b, 0x49, 0x46, 0x00]))) {
    return { engine: 'catsystem2', path: rel, kind: 'kif', version: '', extra: {} };
  }
  if (path.basename(filePath).toLowerCase() === 'nscript.dat') {
    return { engine: 'nscripter', path: rel, kind: 'nscript', version: '', extra: {} };
  }
  if (suffix === '.nsa') {
    try {
      const idx = loadNsaIndex(filePath);
      return { engine: 'nscripter', path: rel, kind: 'nsa', version: 'nsa', extra: { base_offset: idx.baseOffset } };
    } catch {
      return { path: rel, size, suffix, head: unknownHead(head), reason: 'malformed nsa header' };
    }
  }
  if (suffix === '.wolf') {
    if (path.basename(filePath).toLowerCase() === 'data.wolf' && siblingFileExists(filePath, 'game.exe')) {
      return { engine: 'wolf', path: rel, kind: 'wolf', version: '', extra: {} };
    }
    return { path: rel, size, suffix, head: unknownHead(head), reason: 'wolf layout incomplete' };
  }
  const parentName = path.basename(path.dirname(filePath)).toLowerCase();
  const baseLower = path.basename(filePath).toLowerCase();
  if (
    DATA_DIR_RE.test(parentName) &&
    (baseLower === 'resources.assets' ||
      baseLower === 'globalgamemanagers' ||
      (baseLower.startsWith('sharedassets') && baseLower.endsWith('.assets')))
  ) {
    return { engine: 'unity', path: rel, kind: 'serialized', version: '', extra: {} };
  }
  for (const rule of matchers) {
    if (ruleMatchesFile(filePath, suffix, head, rule)) {
      return { engine: rule.engine, path: rel, kind: rule.kind, version: '', extra: {} };
    }
  }
  if (CANDIDATE_SUFFIX.has(suffix) || (suffix === '' && looksBinary(head))) {
    let reason = 'unrecognized container';
    if (head.subarray(0, 4).toString('ascii') === 'RPA-') reason = 'malformed rpa header';
    else if (head.subarray(0, 3).toString('ascii') === 'XP3') reason = 'malformed xp3 header';
    else if (head.subarray(0, 4).equals(Buffer.from([0x4b, 0x49, 0x46, 0x00]))) reason = 'kif magic outside .int';
    else if (suffix === '') reason = 'extensionless binary';
    return { path: rel, size, suffix, head: unknownHead(head), reason };
  }
  return null;
}

export function scanWorkspace(workspace: string, homeDir: string | null = null): ScanResult {
  const root = realpathSafe(workspace);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { hits: [], unknown: [], unknownTotal: 0, engines: [] };
  }
  const matchers = loadCustomMatchers(homeDir);
  const customExts = new Set(matchers.flatMap((m) => m.extensions));
  const prioritySet = new Set([...PRIORITY_SUFFIX, ...customExts]);

  const files: string[] = [];
  function walk(dir: string, depth: number) {
    if (files.length >= MAX_SCAN_FILES || depth >= MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subDirs: string[] = [];
    const fileNames: string[] = [];
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (isSymlinkPath(full)) continue;
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.') && !SKIP_DIRS.has(ent.name.toLowerCase())) {
          subDirs.push(ent.name);
        }
      } else if (ent.isFile() && path.extname(ent.name).toLowerCase() !== '.bak') {
        fileNames.push(ent.name);
      }
    }
    fileNames.sort((a, b) => {
      const pa = prioritySet.has(path.extname(a).toLowerCase()) ? 0 : 1;
      const pb = prioritySet.has(path.extname(b).toLowerCase()) ? 0 : 1;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    });
    for (const name of fileNames) {
      if (files.length >= MAX_SCAN_FILES) return;
      files.push(path.join(dir, name));
    }
    subDirs.sort();
    for (const sub of subDirs) {
      if (files.length >= MAX_SCAN_FILES) return;
      walk(path.join(dir, sub), depth + 1);
    }
  }
  walk(root, 0);

  const hits: ArchiveHit[] = [];
  let unknown: UnknownFile[] = [];
  let unknownTotal = 0;

  for (const f of files) {
    const res = classifyFile(root, f, matchers);
    if (!res) continue;
    if ('engine' in res) hits.push(res);
    else {
      unknownTotal += 1;
      if (unknown.length < MAX_UNKNOWN_FILES) unknown.push(res);
    }
  }

  // Also check Unity *_Data directories for serialized assets beyond budget
  let layoutDirsSeen = 0;
  function walkLayout(dir: string, depth: number) {
    if (layoutDirsSeen >= MAX_LAYOUT_DIRS || depth >= MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    layoutDirsSeen++;
    const dirName = path.basename(dir).toLowerCase();
    if (DATA_DIR_RE.test(dirName)) {
      const fnames = entries.filter((e) => e.isFile()).map((e) => e.name);
      const chosen =
        fnames.find((n) => n.toLowerCase() === 'resources.assets') ||
        fnames.find((n) => n.toLowerCase() === 'globalgamemanagers') ||
        fnames.filter((n) => n.toLowerCase().startsWith('sharedassets') && n.toLowerCase().endsWith('.assets')).sort()[0];
      if (chosen) {
        const p = path.join(dir, chosen);
        const rel = path.relative(root, p).replace(/\\/g, '/');
        if (!hits.some((h) => h.path === rel)) {
          const hd = readAt(p, 0, 8) || Buffer.alloc(0);
          hits.push({
            engine: 'unity',
            path: rel,
            kind: hd.subarray(0, 7).toString('ascii') === 'UnityFS' ? 'unityfs' : 'serialized',
            version: '',
            extra: {},
          });
        }
      }
    }
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && !SKIP_DIRS.has(ent.name.toLowerCase())) {
        const sub = path.join(dir, ent.name);
        if (!isSymlinkPath(sub)) walkLayout(sub, depth + 1);
      }
    }
  }
  walkLayout(root, 0);

  const knownPaths = new Set(hits.map((h) => h.path));
  unknown = unknown.filter((u) => !knownPaths.has(u.path));
  const engines: string[] = [];
  for (const h of hits) {
    if (!engines.includes(h.engine)) engines.push(h.engine);
  }
  return { hits, unknown, unknownTotal: Math.max(unknown.length, unknownTotal), engines };
}

export function selfCheckArchive(
  archivePath: string,
  hit?: ArchiveHit | null,
  profile?: Record<string, unknown> | null
): { ok: boolean; reason: string } {
  if (isSymlinkPath(archivePath) || !fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    return { ok: false, reason: 'missing archive' };
  }
  const matcher = profile ? parseEngineMatcher(profile) : null;
  const current =
    hit ||
    (() => {
      const r = classifyFile(path.dirname(archivePath), archivePath, matcher ? [matcher] : []);
      return r && 'engine' in r ? r : null;
    })();
  if (!current) return { ok: false, reason: 'unrecognized archive' };

  if (profile) {
    const versions = Array.isArray(profile.versions) ? profile.versions.map(String) : [];
    if (versions.length > 0 && current.version && !versions.includes(current.version)) {
      return { ok: false, reason: 'profile mismatch' };
    }
    const kinds = Array.isArray(profile.kinds) ? profile.kinds.map(String) : [];
    if (kinds.length > 0 && !kinds.includes(current.kind)) {
      return { ok: false, reason: 'profile mismatch' };
    }
  }

  if (current.kind === 'rpa') {
    try {
      loadRpaIndex(archivePath, Number(current.extra.offset), Number(current.extra.key || 0));
      return { ok: true, reason: 'rpa index ok' };
    } catch {
      return { ok: false, reason: 'rpa index' };
    }
  }
  if (current.kind === 'xp3') {
    try {
      loadXp3Index(archivePath, Number(current.extra.index_offset));
      return { ok: true, reason: 'xp3 index ok' };
    } catch {
      return { ok: false, reason: 'xp3 index' };
    }
  }
  if (current.kind === 'pe-zip') {
    try {
      inspectPeZip(archivePath);
      return { ok: true, reason: 'pe-zip index ok' };
    } catch {
      return { ok: false, reason: 'pe-zip index' };
    }
  }
  if (current.kind === 'nsa') {
    try {
      loadNsaIndex(archivePath);
      return { ok: true, reason: 'nsa index ok' };
    } catch {
      return { ok: false, reason: 'nsa index' };
    }
  }
  if (matcher && !BUILTIN_ARCHIVE_KINDS.has(current.kind)) {
    const head = readAt(archivePath, 0, 64) || Buffer.alloc(0);
    if (!ruleMatchesFile(archivePath, path.extname(archivePath).toLowerCase(), head, matcher)) {
      return { ok: false, reason: 'custom match mismatch' };
    }
    return { ok: true, reason: 'custom match ok' };
  }
  return { ok: true, reason: 'magic' };
}

export interface LibraryHit {
  engine: string;
  status: 'ready' | 'mismatch' | 'absent';
  reason: string;
  archive?: ArchiveHit;
}

export function matchLibrary(workspace: string, homeDir: string, scan?: ScanResult): LibraryHit[] {
  const found = scan || scanWorkspace(workspace, homeDir);
  const known = new Set(listGlobalEngines(homeDir));
  const out: LibraryHit[] = [];
  for (const engine of found.engines) {
    const archives = found.hits.filter((h) => h.engine === engine);
    if (!known.has(engine)) {
      out.push({ engine, status: 'absent', reason: 'global library has no profile', archive: archives[0] });
      continue;
    }
    const profile = loadEngineProfile(homeDir, engine);
    if (!profile) {
      out.push({ engine, status: 'mismatch', reason: 'profile unreadable', archive: archives[0] });
      continue;
    }
    let worst: { ok: boolean; reason: string; hit: ArchiveHit } | null = null;
    for (const hit of archives) {
      const res = selfCheckArchive(path.join(workspace, hit.path), hit, profile);
      if (!res.ok) {
        worst = { ok: false, reason: res.reason, hit };
        break;
      }
      if (!worst) worst = { ok: true, reason: res.reason, hit };
    }
    if (worst && !worst.ok) {
      out.push({ engine, status: 'mismatch', reason: worst.reason, archive: worst.hit });
    } else if (worst) {
      out.push({ engine, status: 'ready', reason: worst.reason, archive: worst.hit });
    }
  }
  return out;
}

export function findSkillDir(workspace: string, homeDir: string | null, skillName: string): string | null {
  const candidates = [path.join(workspace, '.papercup', 'skills', skillName)];
  if (homeDir) candidates.push(path.join(homeDir, 'skills', skillName));
  for (const dir of candidates) {
    if (!isSymlinkPath(dir) && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const md = path.join(dir, 'SKILL.md');
      if (!isSymlinkPath(md) && fs.existsSync(md) && fs.statSync(md).isFile()) {
        return dir;
      }
    }
  }
  return null;
}

export function skillBinding(workspace: string, homeDir: string | null, engine: string, kind = ''): SkillBinding {
  const norm = engine.trim().toLowerCase();
  if (!norm || !isEngineName(norm)) return { state: 'absent' };
  const profile = resolveEngineJson(workspace, norm, homeDir) ?? (homeDir ? loadEngineProfile(homeDir, norm) : null);
  if (!profile) return { state: 'absent' };
  const pipeline = String(profile.pipeline || '').trim().toLowerCase();
  const isUnpackSkill = pipeline === 'skill';
  const isBuiltinAnalysisSkill =
    pipeline === 'builtin' && typeof profile[SKILL_POINTER] === 'string' && Boolean(String(profile[SKILL_POINTER]).trim());
  if (!isUnpackSkill && !isBuiltinAnalysisSkill) {
    return { state: 'absent' };
  }
  const kinds = Array.isArray(profile.kinds) ? profile.kinds.map(String) : [];
  if (kind && kinds.length > 0 && !kinds.includes(kind)) {
    return { state: 'absent' };
  }
  const skillName = profileSkill(profile);
  const digest = profileSkillDigest(profile);
  const unpackSha = typeof profile[UNPACK_DIGEST] === 'string' ? profile[UNPACK_DIGEST].trim().toLowerCase() : '';
  const repackSha = typeof profile[REPACK_DIGEST] === 'string' ? profile[REPACK_DIGEST].trim().toLowerCase() : '';
  const extractSha = typeof profile[EXTRACT_DIGEST] === 'string' ? profile[EXTRACT_DIGEST].trim().toLowerCase() : '';
  const applySha = typeof profile[APPLY_DIGEST] === 'string' ? profile[APPLY_DIGEST].trim().toLowerCase() : '';
  if (!skillName || !digest || (isUnpackSkill && (!unpackSha || !repackSha))) {
    return { state: 'mismatch' };
  }
  const dir = findSkillDir(workspace, homeDir, skillName);
  if (!dir) return { state: 'mismatch' };
  try {
    const ok =
      sha256Hex(fs.readFileSync(path.join(dir, 'SKILL.md'))) === digest &&
      (!isUnpackSkill ||
        (sha256Hex(fs.readFileSync(path.join(dir, 'unpack.py'))) === unpackSha &&
          sha256Hex(fs.readFileSync(path.join(dir, 'repack.py'))) === repackSha)) &&
      (!extractSha || sha256Hex(fs.readFileSync(path.join(dir, 'extract.py'))) === extractSha) &&
      (!applySha || sha256Hex(fs.readFileSync(path.join(dir, 'apply.py'))) === applySha);
    return ok ? { state: 'ready', directory: dir } : { state: 'mismatch' };
  } catch {
    return { state: 'mismatch' };
  }
}

/* ========================= Harness Overlay & Sandbox Python Runner ========================= */

export function resolveEngineJson(workspace: string, engine: string, homeDir: string | null): Record<string, unknown> | null {
  let merged: Record<string, unknown> | null = null;
  const norm = engine.trim().toLowerCase();
  if (norm && BUILTIN_ENGINE_JSON[norm]) {
    merged = { ...BUILTIN_ENGINE_JSON[norm] };
  }
  if (norm && homeDir) {
    const globalPath = path.join(globalEnginesDir(homeDir), norm, 'engine.json');
    if (!isSymlinkPath(globalPath) && fs.existsSync(globalPath)) {
      try {
        const g = JSON.parse(fs.readFileSync(globalPath, 'utf8'));
        if (g && typeof g === 'object' && !Array.isArray(g)) {
          merged = g as Record<string, unknown>;
        }
      } catch {
        // ignore invalid global
      }
    }
  }
  const projPath = path.join(projectHarnessDir(workspace, homeDir), 'engine.json');
  if (!isSymlinkPath(projPath) && fs.existsSync(projPath)) {
    try {
      const p = JSON.parse(fs.readFileSync(projPath, 'utf8'));
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const projEngine = typeof p.name === 'string' ? p.name.trim().toLowerCase() : '';
        if (!norm || !projEngine || projEngine === norm) {
          merged = p as Record<string, unknown>;
        }
      }
    } catch {
      // ignore invalid project
    }
  }
  return merged;
}

export interface HarnessVersionInfo {
  versionId: string;
  digest: string;
  note: string;
}

export function listHarnessVersions(root: string): HarnessVersionInfo[] {
  const indexPath = path.join(root, '.versions', 'index.jsonl');
  if (isSymlinkPath(indexPath) || !fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const out: HarnessVersionInfo[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as Record<string, unknown>;
      out.push({
        versionId: String(obj.version || ''),
        digest: String(obj.digest || ''),
        note: String(obj.note || ''),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function commitHarness(root: string, updates: Record<string, string>, note = ''): HarnessVersionInfo {
  if (isSymlinkPath(root)) throw new Error('支架目录不能是符号链接');
  const versionsDir = path.join(root, '.versions');
  if (isSymlinkPath(versionsDir)) throw new Error('版本目录不能是符号链接');
  for (const [rel, content] of Object.entries(updates)) {
    if (!HARNESS_COMPONENTS.includes(rel as typeof HARNESS_COMPONENTS[number])) {
      throw new Error(`不是支架组件：${rel}`);
    }
    const dest = path.join(root, rel);
    if (isSymlinkPath(dest)) throw new Error(`拒绝写入符号链接：${rel}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }

  const current: Record<string, string> = {};
  for (const rel of HARNESS_COMPONENTS) {
    const p = path.join(root, rel);
    if (!isSymlinkPath(p) && fs.existsSync(p) && fs.statSync(p).isFile()) {
      current[rel] = fs.readFileSync(p, 'utf8');
    }
  }
  const existing = listHarnessVersions(root);
  const seq = existing.length + 1;
  const versionId = `v${String(seq).padStart(4, '0')}`;
  const vDir = path.join(versionsDir, versionId);
  fs.mkdirSync(vDir, { recursive: true });
  for (const [rel, txt] of Object.entries(current)) {
    const dest = path.join(vDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, txt, 'utf8');
  }
  const canonicalKeys = Object.keys(current).sort();
  const canonJson = '{' + canonicalKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(current[k])}`).join(',') + '}';
  const digest = sha256Hex(canonJson);
  const cleanNote = note.trim().replace(/\s+/g, ' ').slice(0, 200);
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.appendFileSync(
    path.join(versionsDir, 'index.jsonl'),
    JSON.stringify({ version: versionId, digest, note: cleanNote, created: new Date().toISOString() }) + '\n',
    'utf8'
  );
  return { versionId, digest, note: cleanNote };
}

function buildSanitizedEnv(): Record<string, string> {
  const allowKeys = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'WINDIR',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ];
  const env: Record<string, string> = { PYTHONIOENCODING: 'utf-8' };
  for (const k of allowKeys) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

export async function runPythonScript(
  scriptPath: string,
  args: string[],
  cwd: string,
  timeoutMs = SCRIPT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<void> {
  if (isSymlinkPath(scriptPath) || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    throw new ArchiveError('脚本不存在或是符号链接');
  }
  const resolved = path.resolve(scriptPath);
  const st = fs.statSync(resolved);
  if (st.size <= 0 || st.size > MAX_SCRIPT_BYTES) {
    throw new ArchiveError('脚本大小不合法');
  }
  if (isSymlinkPath(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new ArchiveError('脚本工作目录不存在');
  }
  try {
    await execFileAsync(config.pythonPath, ['-I', resolved, ...args.map(String)], {
      cwd,
      timeout: timeoutMs,
      signal,
      env: buildSanitizedEnv(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const e = err as { killed?: boolean; code?: number | string; stderr?: string; stdout?: string; message?: string };
    if (e.killed) {
      throw new ArchiveError(`脚本超时（超过 ${timeoutMs / 1000} 秒）：${path.basename(resolved)}`);
    }
    const detail = ((e.stderr || e.stdout || e.message || '') as string).trim().replace(/\s+/g, ' ').slice(0, 240);
    throw new ArchiveError(`脚本失败（${path.basename(resolved)}，退出码 ${e.code ?? 1}）${detail ? '：' + detail : ''}`);
  }
}

export function findUnpackManifests(sourceOrWorkspace: string): string[] {
  const names = new Set([SKILL_MANIFEST, COMPOSE_MANIFEST, RPA_MANIFEST, XP3_MANIFEST, PEZIP_MANIFEST, NSA_MANIFEST]);
  const found: string[] = [];
  const root = realpathSafe(sourceOrWorkspace);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return found;
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (isSymlinkPath(full)) continue;
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === '.papercup' || ent.name === 'node_modules') continue;
        walk(full);
      } else if (ent.isFile() && names.has(ent.name)) {
        found.push(full);
      }
    }
  }
  const unpackedDir = path.join(root, 'unpacked');
  if (fs.existsSync(unpackedDir) && fs.statSync(unpackedDir).isDirectory()) {
    walk(unpackedDir);
  }
  if (found.length === 0) walk(root);
  return found.sort();
}

export function collectedNamesInUnpacked(outDir: string, manifestName: string): string[] {
  const names: string[] = [];
  function walk(dir: string) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (isSymlinkPath(full)) continue;
      if (ent.isDirectory()) {
        if (!ent.name.startsWith('.')) walk(full);
      } else if (ent.isFile()) {
        if (ent.name === manifestName || ent.name.startsWith('.')) continue;
        names.push(path.relative(outDir, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(outDir);
  return names.sort();
}
