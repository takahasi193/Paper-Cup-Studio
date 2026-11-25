/**
 * Deterministic Win32 Proxy DLL resolution and PE import/architecture inspection.
 * Pure Node.js standard modules only — zero external dependencies and no imports
 * from `profile.ts`, `patch.ts`, or `smoke.ts` to avoid circular dependencies.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_PROXY_DLLS = ['version.dll', 'winmm.dll'] as const;
export type ProxyDllName = (typeof SUPPORTED_PROXY_DLLS)[number];

export interface ResolvedProxyDll {
  path: string;
  arch: 'x86' | 'x64';
  name: ProxyDllName;
  sha256: string;
  bytes: number;
}

const MAX_PE_SECTIONS = 256;
const MAX_IMPORT_DESCRIPTORS = 256;
const MAX_DLL_NAME_BYTES = 260;

function isSymlinkSafe(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function normalizeProxyDllName(raw?: unknown): ProxyDllName | undefined {
  if (typeof raw !== 'string') return undefined;
  const low = raw.trim().toLowerCase();
  if (!low) return undefined;
  if (low === 'version' || low === 'version.dll') return 'version.dll';
  if (low === 'winmm' || low === 'winmm.dll') return 'winmm.dll';
  return undefined;
}

export function readPeMachineArch(filePath: string): 'x86' | 'x64' | 'unknown' {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) < 64) return 'unknown';
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return 'unknown'; // 'MZ'
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > 16 * 1024 * 1024) return 'unknown';
    const pe = Buffer.alloc(6);
    if (fs.readSync(fd, pe, 0, 6, peOffset) < 6) return 'unknown';
    if (pe[0] !== 0x50 || pe[1] !== 0x45 || pe[2] !== 0x00 || pe[3] !== 0x00) return 'unknown'; // 'PE\0\0'
    const machine = pe.readUInt16LE(4);
    if (machine === 0x014c) return 'x86';
    if (machine === 0x8664) return 'x64';
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

/**
 * Pure Node.js PE32 (0x10b) / PE32+ (0x20b) Import Directory parser using bounded
 * file descriptor reads. Never throws on malformed or non-PE inputs.
 */
export function readPeImportedDlls(filePath: string): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 64) return [];
    const fileSize = st.size;

    const readExact = (offset: number, length: number): Buffer | null => {
      if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length <= 0) {
        return null;
      }
      if (offset + length > fileSize) return null;
      const buf = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const n = fs.readSync(fd!, buf, total, length - total, offset + total);
        if (n <= 0) return null;
        total += n;
      }
      return buf;
    };

    const readPartial = (offset: number, maxLength: number): Buffer | null => {
      if (!Number.isFinite(offset) || offset < 0 || offset >= fileSize || maxLength <= 0) {
        return null;
      }
      const len = Math.min(maxLength, fileSize - offset);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd!, buf, 0, len, offset);
      return n > 0 ? buf.subarray(0, n) : null;
    };

    const dos = readExact(0, 64);
    if (!dos || dos[0] !== 0x4d || dos[1] !== 0x5a) return [];
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset + 24 > fileSize) return [];

    const peHeader = readExact(peOffset, 24);
    if (!peHeader) return [];
    if (peHeader[0] !== 0x50 || peHeader[1] !== 0x45 || peHeader[2] !== 0x00 || peHeader[3] !== 0x00) {
      return [];
    }

    const numberOfSections = peHeader.readUInt16LE(6);
    const sizeOfOptionalHeader = peHeader.readUInt16LE(20);
    if (numberOfSections === 0 || numberOfSections > MAX_PE_SECTIONS || sizeOfOptionalHeader < 96) {
      return [];
    }

    const optOffset = peOffset + 24;
    if (optOffset + sizeOfOptionalHeader > fileSize) return [];

    const opt = readExact(optOffset, Math.min(sizeOfOptionalHeader, 4096));
    if (!opt || opt.length < 96) return [];

    const magic = opt.readUInt16LE(0);
    let dataDirBase: number;
    let numRvaOffset: number;
    if (magic === 0x10b) {
      dataDirBase = 96;
      numRvaOffset = 92;
    } else if (magic === 0x20b) {
      dataDirBase = 112;
      numRvaOffset = 108;
    } else {
      return [];
    }

    const importDirRelOffset = dataDirBase + 8; // DataDirectory[1] (Import Table)
    if (sizeOfOptionalHeader < importDirRelOffset + 8 || opt.length < importDirRelOffset + 8) {
      return [];
    }

    const numberOfRvaAndSizes = opt.readUInt32LE(numRvaOffset);
    if (numberOfRvaAndSizes < 2) return [];

    const importRva = opt.readUInt32LE(importDirRelOffset);
    if (importRva === 0) return [];
    const sizeOfHeaders = opt.length >= 64 ? opt.readUInt32LE(60) : 0;

    const sectionTableOffset = optOffset + sizeOfOptionalHeader;
    const sectionTableBuf = readExact(sectionTableOffset, numberOfSections * 40);
    if (!sectionTableBuf) return [];

    const sections: Array<{
      virtualSize: number;
      virtualAddress: number;
      sizeOfRawData: number;
      pointerToRawData: number;
    }> = [];
    for (let i = 0; i < numberOfSections; i++) {
      const base = i * 40;
      sections.push({
        virtualSize: sectionTableBuf.readUInt32LE(base + 8),
        virtualAddress: sectionTableBuf.readUInt32LE(base + 12),
        sizeOfRawData: sectionTableBuf.readUInt32LE(base + 16),
        pointerToRawData: sectionTableBuf.readUInt32LE(base + 20),
      });
    }

    const rvaToFileOffset = (rva: number): number | null => {
      const uRva = rva >>> 0;
      for (const sec of sections) {
        if (sec.pointerToRawData === 0 || sec.sizeOfRawData === 0) continue;
        if (uRva < sec.virtualAddress) continue;
        const delta = uRva - sec.virtualAddress;
        const maxVirtualSpan = sec.virtualSize > 0 ? Math.max(sec.virtualSize, sec.sizeOfRawData) : sec.sizeOfRawData;
        if (delta < maxVirtualSpan && delta < sec.sizeOfRawData) {
          const fileOff = sec.pointerToRawData + delta;
          if (fileOff >= 0 && fileOff < fileSize) return fileOff;
        }
      }
      if (sizeOfHeaders > 0 && uRva < sizeOfHeaders && uRva < fileSize) {
        return uRva;
      }
      return null;
    };

    const out: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < MAX_IMPORT_DESCRIPTORS; i++) {
      const descRva = (importRva + i * 20) >>> 0;
      const descOff = rvaToFileOffset(descRva);
      if (descOff === null) break;
      const desc = readExact(descOff, 20);
      if (!desc) break;

      const originalFirstThunk = desc.readUInt32LE(0);
      const timeDateStamp = desc.readUInt32LE(4);
      const forwarderChain = desc.readUInt32LE(8);
      const nameRva = desc.readUInt32LE(12);
      const firstThunk = desc.readUInt32LE(16);

      if (
        originalFirstThunk === 0 &&
        timeDateStamp === 0 &&
        forwarderChain === 0 &&
        nameRva === 0 &&
        firstThunk === 0
      ) {
        break;
      }
      if (nameRva === 0) break;

      const nameOff = rvaToFileOffset(nameRva);
      if (nameOff === null) continue;
      const nameBuf = readPartial(nameOff, MAX_DLL_NAME_BYTES);
      if (!nameBuf) continue;
      const nul = nameBuf.indexOf(0);
      if (nul <= 0) continue;
      const rawName = nameBuf.subarray(0, nul).toString('latin1');
      if (!/^[\x20-\x7e]+$/.test(rawName)) continue;
      const normalized = rawName.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }

    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

export function chooseProxyDllName(exePath: string | null, explicitProxyDll?: ProxyDllName): ProxyDllName {
  if (explicitProxyDll) return explicitProxyDll;
  if (exePath && !isSymlinkSafe(exePath) && fs.existsSync(exePath)) {
    const imported = readPeImportedDlls(exePath);
    if (imported.includes('version.dll')) return 'version.dll';
    if (imported.includes('winmm.dll')) return 'winmm.dll';
  }
  return 'version.dll';
}

export function resolvePrebuiltProxyDll(
  arch: 'x86' | 'x64' | 'unknown',
  proxyDllName: ProxyDllName,
  options?: { binDir?: string | null }
): ResolvedProxyDll | null {
  if (arch !== 'x86' && arch !== 'x64') return null;

  const hasExplicitBinDir = options?.binDir !== undefined && options?.binDir !== null;
  let rawRoots: string[];
  if (hasExplicitBinDir) {
    const explicit = options.binDir!.trim();
    if (!explicit) return null;
    rawRoots = [explicit];
  } else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    rawRoots = [
      process.env.PAPERCUP_WIN32_PROXY_DIR?.trim() || '',
      path.resolve(here, '..', '..', 'native', 'win32-proxy', 'bin'),
      path.resolve(here, '..', '..', '..', 'native', 'win32-proxy', 'bin'),
      path.resolve(process.cwd(), 'native', 'win32-proxy', 'bin'),
      path.resolve(process.cwd(), 'server', 'native', 'win32-proxy', 'bin'),
    ];
  }

  const seenRoots = new Set<string>();
  const candidateRoots: string[] = [];
  for (const r of rawRoots) {
    if (!r) continue;
    const resolved = path.resolve(r);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    candidateRoots.push(resolved);
  }

  for (const root of candidateRoots) {
    const cand = path.join(root, arch, proxyDllName);
    try {
      if (isSymlinkSafe(cand) || !fs.existsSync(cand)) continue;
      const st = fs.statSync(cand);
      if (!st.isFile() || st.size <= 0) continue;
      if (readPeMachineArch(cand) !== arch) continue;
      const buf = fs.readFileSync(cand);
      if (buf.length <= 0) continue;
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      return {
        path: cand,
        arch,
        name: proxyDllName,
        sha256,
        bytes: buf.length,
      };
    } catch {
      // Try next candidate root
    }
  }

  return null;
}
