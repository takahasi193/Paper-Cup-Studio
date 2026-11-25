/**
 * Reference Oracle solutions (L1 -> L6) and Adversarial Negative Self-Checks
 * for the Paper Cup Reverser Benchmark.
 *
 * Used by `--mode oracle` to verify with ZERO LLM tokens that:
 *   1. All 6 tasks are 100% solvable and pass all 8 strict hard-constraint gates (G1-G8).
 *   2. Realistic cheating / defective reverser behaviors (e.g. `_WB`-only cheat,
 *      undecoded half-width katakana, decoy STR0-only extraction, blind global u32 VM patching,
 *      missing control_pattern) are strictly caught and rejected by Paper Cup + the grader.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { learnUnpackSkill } from '../../src/vn/workflow.js';
import { BENCH_TASKS } from './fixtures.js';
import { gradeReverserRun, snapshotDirSha256 } from './grader.js';
import type { BenchTaskSpec } from './types.js';

interface OracleSpec {
  engine: string;
  pipeline: 'skill' | 'direct';
  archive?: string;
  unpackedDir?: string;
  suffix?: string;
  magicHex?: string;
  encoding: string;
  controlPattern?: string;
  rasterUiAssets?: string[];
  scripts: {
    unpack?: string;
    repack?: string;
    extract: string;
    apply: string;
  };
  layoutMd: string;
  hypothesesMd: string;
  textMappingJson: Record<string, unknown>;
}

const PY_HEADER = `#!/usr/bin/env python3\nimport json, os, re, struct, sys, zlib\n`;

/* ========================= L1 Oracle ========================= */

const L1_UNPACK = `${PY_HEADER}
def main():
    arc, out_dir = sys.argv[1], sys.argv[2]
    data = open(arc, 'rb').read()
    assert data[:4] == b'VP1\\x00', 'bad VP1 magic'
    count = struct.unpack_from('<I', data, 4)[0]
    pos = 8
    os.makedirs(out_dir, exist_ok=True)
    for _ in range(count):
        nlen = struct.unpack_from('<H', data, pos)[0]; pos += 2
        name = data[pos:pos+nlen].decode('utf-8'); pos += nlen
        off, size = struct.unpack_from('<II', data, pos); pos += 8
        dst = os.path.join(out_dir, *name.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(data[off:off+size])

if __name__ == '__main__':
    main()
`;

const L1_REPACK = `${PY_HEADER}
SKIP_FILES = {'.papercup-skill-manifest.json'}

def main():
    src_dir, out_arc = sys.argv[1], sys.argv[2]
    entries = []
    for root, _, files in os.walk(src_dir):
        for fn in sorted(files):
            if fn in SKIP_FILES or fn.endswith('.bak'):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, src_dir).replace('\\\\', '/')
            entries.append((rel, open(full, 'rb').read()))
    entries.sort(key=lambda x: x[0])
    toc_len = 8 + sum(2 + len(n.encode('utf-8')) + 8 for n, _ in entries)
    off = toc_len
    toc = bytearray(b'VP1\\x00' + struct.pack('<I', len(entries)))
    for n, blob in entries:
        nb = n.encode('utf-8')
        toc += struct.pack('<H', len(nb)) + nb + struct.pack('<II', off, len(blob))
        off += len(blob)
    os.makedirs(os.path.dirname(os.path.abspath(out_arc)), exist_ok=True)
    with open(out_arc, 'wb') as f:
        f.write(toc)
        for _, blob in entries:
            f.write(blob)

if __name__ == '__main__':
    main()
`;

const L1_EXTRACT = `${PY_HEADER}
def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    rows = []
    idx = 0
    for root, _, files in os.walk(in_dir):
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, in_dir).replace('\\\\', '/')
            if rel.endswith('.vsc'):
                for lineno, line in enumerate(open(full, 'r', encoding='utf-8'), 1):
                    s = line.strip()
                    m = re.match(r'^say\\s+"(.*)"$', s)
                    if m:
                        idx += 1
                        rows.append({'id': f'vp1_{idx:04d}', 'file': rel, 'line': lineno, 'kind': 'say', 'source': m.group(1)})
                        continue
                    m = re.match(r'^@name\\s+(.+)$', s)
                    if m:
                        idx += 1
                        rows.append({'id': f'vp1_{idx:04d}', 'file': rel, 'line': lineno, 'kind': 'name', 'source': m.group(1).strip()})
                        continue
                    m = re.match(r'^#choice\\s+(.+)$', s)
                    if m:
                        idx += 1
                        rows.append({'id': f'vp1_{idx:04d}', 'file': rel, 'line': lineno, 'kind': 'choice', 'source': m.group(1).strip()})
            elif rel == 'ui/menu.json':
                obj = json.loads(open(full, 'r', encoding='utf-8').read())
                labels = obj.get('labels', {})
                for k_i, (k, v) in enumerate(labels.items(), 1):
                    idx += 1
                    rows.append({'id': f'vp1_{idx:04d}', 'file': rel, 'line': k_i, 'kind': 'system', 'source': str(v), 'key': k})
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')

if __name__ == '__main__':
    main()
`;

const L1_APPLY = `${PY_HEADER}
def main():
    jsonl_path, target_dir = sys.argv[1], sys.argv[2]
    by_file = {}
    for line in open(jsonl_path, 'r', encoding='utf-8'):
        if not line.strip(): continue
        row = json.loads(line)
        by_file.setdefault(row['file'], []).append(row)

    for rel, items in by_file.items():
        full = os.path.join(target_dir, *rel.split('/'))
        if rel.endswith('.vsc'):
            by_line = {int(r['line']): r['target'] for r in items}
            lines = open(full, 'r', encoding='utf-8').read().splitlines(True)
            out_lines = []
            for lineno, raw in enumerate(lines, 1):
                if lineno in by_line:
                    tgt = by_line[lineno]
                    eol = '\\r\\n' if raw.endswith('\\r\\n') else ('\\n' if raw.endswith('\\n') else '')
                    s = raw.strip()
                    if s.startswith('say "'):
                        raw = f'say "{tgt}"{eol}'
                    elif s.startswith('@name '):
                        raw = f'@name {tgt}{eol}'
                    elif s.startswith('#choice '):
                        raw = f'#choice {tgt}{eol}'
                out_lines.append(raw)
            with open(full, 'w', encoding='utf-8', newline='') as f:
                f.writelines(out_lines)
        elif rel == 'ui/menu.json':
            obj = json.loads(open(full, 'r', encoding='utf-8').read())
            labels = obj.get('labels', {})
            keys = list(labels.keys())
            for r in items:
                k = r.get('key') or (keys[int(r['line']) - 1] if 1 <= int(r['line']) <= len(keys) else None)
                if k is not None and k in labels:
                    labels[k] = r['target']
            with open(full, 'w', encoding='utf-8', newline='\\n') as f:
                f.write(json.dumps(obj, ensure_ascii=False, indent=2) + '\\n')

if __name__ == '__main__':
    main()
`;

/* ========================= L2 Oracle ========================= */

const L2_UNPACK = `${PY_HEADER}
def xor_stream(data: bytes, seed: int) -> bytes:
    return bytes(b ^ ((seed + i * 17) & 0xFF) for i, b in enumerate(data))

def main():
    arc, out_dir = sys.argv[1], sys.argv[2]
    data = open(arc, 'rb').read()
    assert data[:4] == b'XPK2', 'bad XPK2 magic'
    seed, count, toc_len = struct.unpack_from('<III', data, 4)
    toc = xor_stream(data[16:16+toc_len], seed)
    body = xor_stream(data[16+toc_len:], (seed + 1) & 0xFF)
    pos = 0
    os.makedirs(out_dir, exist_ok=True)
    for _ in range(count):
        nlen = struct.unpack_from('<H', toc, pos)[0]; pos += 2
        name = toc[pos:pos+nlen].decode('ascii'); pos += nlen
        off, size = struct.unpack_from('<II', toc, pos); pos += 8
        dst = os.path.join(out_dir, *name.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(body[off:off+size])

if __name__ == '__main__':
    main()
`;

const L2_REPACK = `${PY_HEADER}
SKIP_FILES = {'.papercup-skill-manifest.json'}

def xor_stream(data: bytes, seed: int) -> bytes:
    return bytes(b ^ ((seed + i * 17) & 0xFF) for i, b in enumerate(data))

def main():
    src_dir, out_arc = sys.argv[1], sys.argv[2]
    seed = 0x5A
    entries = []
    for root, _, files in os.walk(src_dir):
        for fn in sorted(files):
            if fn in SKIP_FILES or fn.endswith('.bak'):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, src_dir).replace('\\\\', '/')
            entries.append((rel, open(full, 'rb').read()))
    entries.sort(key=lambda x: x[0])
    toc = bytearray()
    body = bytearray()
    for n, blob in entries:
        nb = n.encode('ascii')
        toc += struct.pack('<H', len(nb)) + nb + struct.pack('<II', len(body), len(blob))
        body += blob
    enc_toc = xor_stream(bytes(toc), seed)
    enc_body = xor_stream(bytes(body), (seed + 1) & 0xFF)
    os.makedirs(os.path.dirname(os.path.abspath(out_arc)), exist_ok=True)
    with open(out_arc, 'wb') as f:
        f.write(b'XPK2' + struct.pack('<III', seed, len(entries), len(toc)) + enc_toc + enc_body)

if __name__ == '__main__':
    main()
`;

const L2_EXTRACT = `${PY_HEADER}
def decode_text(raw: bytes) -> str:
    for enc in ('cp932', 'gbk', 'utf-8'):
        try:
            return raw.decode(enc)
        except Exception:
            pass
    return raw.decode('cp932', errors='replace')

def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    rows = []
    idx = 0
    for root, _, files in os.walk(in_dir):
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, in_dir).replace('\\\\', '/')
            if rel.endswith('.s'):
                text = decode_text(open(full, 'rb').read())
                for lineno, line in enumerate(text.splitlines(), 1):
                    m = re.match(r'^\\[(SAY|NAME|CHOICE)\\]\\s+(.+)$', line.strip())
                    if m:
                        idx += 1
                        rows.append({'id': f'xpk_{idx:04d}', 'file': rel, 'line': lineno, 'kind': m.group(1).lower(), 'source': m.group(2)})
            elif rel == 'sys/labels.txt':
                text = decode_text(open(full, 'rb').read())
                for lineno, line in enumerate(text.splitlines(), 1):
                    m = re.match(r'^LABEL_\\d+=(.+)$', line.strip())
                    if m:
                        idx += 1
                        rows.append({'id': f'xpk_{idx:04d}', 'file': rel, 'line': lineno, 'kind': 'system', 'source': m.group(1)})
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')

if __name__ == '__main__':
    main()
`;

const L2_APPLY = `${PY_HEADER}
def main():
    jsonl_path, target_dir = sys.argv[1], sys.argv[2]
    enc = os.environ.get('PAPERCUP_TARGET_ENCODING', 'cp932').strip() or 'cp932'
    by_file = {}
    for line in open(jsonl_path, 'r', encoding='utf-8'):
        if not line.strip(): continue
        row = json.loads(line)
        by_file.setdefault(row['file'], {})[int(row['line'])] = row['target']

    for rel, line_map in by_file.items():
        full = os.path.join(target_dir, *rel.split('/'))
        raw = open(full, 'rb').read()
        try:
            text = raw.decode('cp932')
        except Exception:
            text = raw.decode(enc, errors='replace')
        out_lines = []
        for lineno, line in enumerate(text.splitlines(), 1):
            if lineno in line_map:
                tgt = line_map[lineno]
                m = re.match(r'^(\\[(?:SAY|NAME|CHOICE)\\]\\s+)(.+)$', line)
                if m:
                    line = m.group(1) + tgt
                else:
                    m2 = re.match(r'^(LABEL_\\d+=)(.+)$', line)
                    if m2:
                        line = m2.group(1) + tgt
            out_lines.append(line)
        out_bytes = ('\\r\\n'.join(out_lines) + '\\r\\n').encode(enc)
        with open(full, 'wb') as f:
            f.write(out_bytes)

if __name__ == '__main__':
    main()
`;

/* ========================= L3 Oracle ========================= */

const L3_COMMON_PY = `
import unicodedata

HW_KANA_RE = re.compile(r'[\\uFF61-\\uFF9F]+')
def hw_to_fw(s: str) -> str:
    return HW_KANA_RE.sub(lambda m: unicodedata.normalize('NFKC', m.group(0)), s)

FW_TO_HW = {
    'ア':'ｱ','イ':'ｲ','ウ':'ｳ','エ':'ｴ','オ':'ｵ','カ':'ｶ','キ':'ｷ','ク':'ｸ','ケ':'ｹ','コ':'ｺ',
    'サ':'ｻ','シ':'ｼ','ス':'ｽ','セ':'ｾ','ソ':'ｿ','タ':'ﾀ','チ':'ﾁ','ツ':'ﾂ','テ':'ﾃ','ト':'ﾄ',
    'ナ':'ﾅ','ニ':'ﾆ','ヌ':'ﾇ','ネ':'ﾈ','ノ':'ﾉ','ハ':'ﾊ','ヒ':'ﾋ','フ':'ﾌ','ヘ':'ﾍ','ホ':'ﾎ',
    'マ':'ﾏ','ミ':'ﾐ','ム':'ﾑ','メ':'ﾒ','モ':'ﾓ','ヤ':'ﾔ','ユ':'ﾕ','ヨ':'ﾖ',
    'ラ':'ﾗ','リ':'ﾘ','ル':'ﾙ','レ':'ﾚ','ロ':'ﾛ','ワ':'ﾜ','ヲ':'ｦ','ン':'ﾝ',
    'ァ':'ｧ','ィ':'ｨ','ゥ':'ｩ','ェ':'ｪ','ォ':'ｫ','ャ':'ｬ','ュ':'ｭ','ョ':'ｮ','ッ':'ｯ','ー':'ｰ',
    'ガ':'ｶﾞ','ギ':'ｷﾞ','グ':'ｸﾞ','ゲ':'ｹﾞ','ゴ':'ｺﾞ','ザ':'ｻﾞ','ジ':'ｼﾞ','ズ':'ｽﾞ','ゼ':'ｾﾞ','ゾ':'ｿﾞ',
    'ダ':'ﾀﾞ','ヂ':'ﾁﾞ','ヅ':'ﾂﾞ','デ':'ﾃﾞ','ド':'ﾄﾞ','バ':'ﾊﾞ','ビ':'ﾋﾞ','ブ':'ﾌﾞ','ベ':'ﾍﾞ','ボ':'ﾎﾞ',
    'パ':'ﾊﾟ','ピ':'ﾋﾟ','プ':'ﾌﾟ','ペ':'ﾍﾟ','ポ':'ﾎﾟ','ヴ':'ｳﾞ'
}
def fw_to_hw(s: str) -> str:
    return ''.join(FW_TO_HW.get(ch, ch) for ch in s)

KIND_MAP = {1: 'say', 2: 'name', 3: 'choice', 4: 'system'}

def parse_bscr(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'BSCR'
    ver, ulen, clen = struct.unpack_from('<III', raw, 4)
    plain = zlib.decompress(raw[16:16+clen])
    assert len(plain) == ulen
    count = struct.unpack_from('<I', plain, 0)[0]
    pos = 4
    recs = []
    for _ in range(count):
        rid, kind, blen = struct.unpack_from('<IBH', plain, pos); pos += 7
        payload = plain[pos:pos+blen]; pos += blen
        recs.append((rid, kind, payload))
    return ver, plain, recs
`;

const L3_EXTRACT = `${PY_HEADER}${L3_COMMON_PY}
def decode_payload(b: bytes) -> str:
    for enc in ('cp932', 'gbk', 'utf-8'):
        try:
            return b.decode(enc)
        except Exception:
            pass
    return b.decode('cp932', errors='replace')

def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    bscr = os.path.join(in_dir, 'scenario.bscr')
    _, _, recs = parse_bscr(bscr)
    rows = []
    for rid, kind, payload in recs:
        if kind not in KIND_MAP:
            continue
        text = hw_to_fw(decode_payload(payload))
        rows.append({'id': f'bscr_{rid}', 'file': 'scenario.bscr', 'line': rid, 'kind': KIND_MAP[kind], 'source': text})
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')

if __name__ == '__main__':
    main()
`;

const L3_APPLY = `${PY_HEADER}${L3_COMMON_PY}
def main():
    jsonl_path, target_dir = sys.argv[1], sys.argv[2]
    enc = os.environ.get('PAPERCUP_TARGET_ENCODING', 'cp932').strip().lower() or 'cp932'
    by_rid = {}
    for line in open(jsonl_path, 'r', encoding='utf-8'):
        if not line.strip(): continue
        row = json.loads(line)
        by_rid[int(row['line'])] = row['target']

    bscr = os.path.join(target_dir, 'scenario.bscr')
    ver, orig_plain, recs = parse_bscr(bscr)
    body = bytearray(struct.pack('<I', len(recs)))
    for rid, kind, payload in recs:
        if kind != 9 and rid in by_rid:
            tgt = by_rid[rid]
            if enc in ('cp932', 'shift_jis', 'shift-jis'):
                tgt = fw_to_hw(tgt)
            payload = tgt.encode(enc)
        body += struct.pack('<IBH', rid, kind, len(payload)) + payload
    if bytes(body) == orig_plain:
        return
    comp = zlib.compress(bytes(body))
    with open(bscr, 'wb') as f:
        f.write(b'BSCR' + struct.pack('<III', ver, len(body), len(comp)) + comp)

if __name__ == '__main__':
    main()
`;

/* ========================= L4 Oracle ========================= */

const L4_COMMON_PY = `
def dec_msg1(b: bytes) -> bytes:
    return bytes(((x ^ 0xA5) - 0x47 - j) & 0xFF for j, x in enumerate(b))

def enc_msg1(b: bytes) -> bytes:
    return bytes(((x + 0x47 + j) & 0xFF) ^ 0xA5 for j, x in enumerate(b))

def parse_cbin(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'CBIN'
    ulen, clen = struct.unpack_from('<II', raw, 4)
    plain = zlib.decompress(raw[12:12+clen])
    assert len(plain) == ulen
    pos = 0
    assert plain[pos:pos+4] == b'STR0'
    str0_len = struct.unpack_from('<I', plain, pos+4)[0]; pos += 8
    str0_end = pos + str0_len
    str0_cnt = struct.unpack_from('<I', plain, pos)[0]; sp = pos + 4
    str0 = []
    for _ in range(str0_cnt):
        nul = plain.index(0, sp)
        str0.append(plain[sp:nul])
        sp = nul + 1
    pos = str0_end
    assert plain[pos:pos+4] == b'MSG1'
    msg1_len = struct.unpack_from('<I', plain, pos+4)[0]; pos += 8
    msg1_end = pos + msg1_len
    msg1_cnt = struct.unpack_from('<I', plain, pos)[0]; mp = pos + 4
    msg1 = []
    for _ in range(msg1_cnt):
        mlen = struct.unpack_from('<I', plain, mp)[0]; mp += 4
        msg1.append(dec_msg1(plain[mp:mp+mlen]))
        mp += mlen
    pos = msg1_end
    assert plain[pos:pos+4] == b'TAIL'
    tail = plain[pos:]
    return plain, str0, msg1, tail

def decode_any(b: bytes) -> str:
    for enc in ('cp932', 'gbk', 'utf-8'):
        try:
            return b.decode(enc)
        except Exception:
            pass
    return b.decode('cp932', errors='replace')

def is_real_ui_str0(s: str) -> bool:
    if not s or any(tok in s for tok in ('(nonnull)', '::', 'ERROR_', 'DEBUG_', 'Asset/', 'GetPanel', 'GetButton', 'GetForm', 'GetSpinBox', 'GetCheckBox')):
        return False
    return bool(re.search(r'[\\u3040-\\u30FF\\u4E00-\\u9FFF]', s))
`;

const L4_EXTRACT = `${PY_HEADER}${L4_COMMON_PY}
def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    cbin = os.path.join(in_dir, 'trial.cbin')
    _, str0, msg1, _ = parse_cbin(cbin)
    rows = []
    for i, b in enumerate(msg1):
        txt = decode_any(b)
        # Short pure katakana/name slots (first 4) vs dialogue sentences
        kind = 'name' if (len(txt) <= 8 and '。' not in txt and '「' not in txt) else 'say'
        rows.append({'id': f'msg1_{i:04d}', 'file': 'trial.cbin', 'line': 1000 + i, 'kind': kind, 'source': txt})
    for i, b in enumerate(str0):
        txt = decode_any(b)
        if is_real_ui_str0(txt):
            rows.append({'id': f'str0_{i:04d}', 'file': 'trial.cbin', 'line': 2000 + i, 'kind': 'system', 'source': txt})
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')

if __name__ == '__main__':
    main()
`;

const L4_APPLY = `${PY_HEADER}${L4_COMMON_PY}
def main():
    jsonl_path, target_dir = sys.argv[1], sys.argv[2]
    enc = os.environ.get('PAPERCUP_TARGET_ENCODING', 'cp932').strip() or 'cp932'
    msg1_map = {}
    str0_map = {}
    for line in open(jsonl_path, 'r', encoding='utf-8'):
        if not line.strip(): continue
        row = json.loads(line)
        ln = int(row['line'])
        if 1000 <= ln < 2000:
            msg1_map[ln - 1000] = row['target']
        elif ln >= 2000:
            str0_map[ln - 2000] = row['target']

    cbin = os.path.join(target_dir, 'trial.cbin')
    orig_plain, str0, msg1, tail = parse_cbin(cbin)
    new_str0 = [str0_map[i].encode(enc) if i in str0_map else b for i, b in enumerate(str0)]
    new_msg1 = [msg1_map[i].encode(enc) if i in msg1_map else b for i, b in enumerate(msg1)]

    str0_body = bytearray(struct.pack('<I', len(new_str0)))
    for b in new_str0:
        str0_body += b + b'\\x00'
    msg1_body = bytearray(struct.pack('<I', len(new_msg1)))
    for b in new_msg1:
        eb = enc_msg1(b)
        msg1_body += struct.pack('<I', len(eb)) + eb
    plain = (
        b'STR0' + struct.pack('<I', len(str0_body)) + bytes(str0_body)
        + b'MSG1' + struct.pack('<I', len(msg1_body)) + bytes(msg1_body)
        + tail
    )
    if plain == orig_plain:
        return
    comp = zlib.compress(plain)
    with open(cbin, 'wb') as f:
        f.write(b'CBIN' + struct.pack('<II', len(plain), len(comp)) + comp)

if __name__ == '__main__':
    main()
`;

/* ========================= L5 Oracle ========================= */

const L5_COMMON_PY = `
TEXT_OPS = {0x0010: 'say', 0x0011: 'name', 0x0012: 'choice', 0x0013: 'system'}

def parse_text_dat(path):
    raw = open(path, 'rb').read()
    entries = []
    pos = 0
    while pos < len(raw):
        nul = raw.index(0, pos)
        entries.append((pos, raw[pos:nul]))
        pos = nul + 1
    return entries

def parse_vm(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'VM01'
    count = struct.unpack_from('<I', raw, 4)[0]
    instrs = []
    for i in range(count):
        op, arg0, operand = struct.unpack_from('<HHI', raw, 8 + i * 8)
        instrs.append((op, arg0, operand))
    return instrs

def decode_any(b: bytes) -> str:
    for enc in ('cp932', 'gbk', 'utf-8'):
        try:
            return b.decode(enc)
        except Exception:
            pass
    return b.decode('cp932', errors='replace')
`;

const L5_EXTRACT = `${PY_HEADER}${L5_COMMON_PY}
def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    entries = parse_text_dat(os.path.join(in_dir, 'TEXT.DAT'))
    instrs = parse_vm(os.path.join(in_dir, 'SCRIPT.VM'))
    kind_by_off = {}
    for op, _, operand in instrs:
        if op in TEXT_OPS and operand not in kind_by_off:
            kind_by_off[operand] = TEXT_OPS[op]
    rows = []
    for idx, (off, raw_b) in enumerate(entries):
        if off not in kind_by_off:
            continue
        rows.append({
            'id': f'vm_str_{idx:04d}',
            'file': 'TEXT.DAT',
            'line': idx + 1,
            'kind': kind_by_off[off],
            'source': decode_any(raw_b),
        })
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')

if __name__ == '__main__':
    main()
`;

const L5_APPLY = `${PY_HEADER}${L5_COMMON_PY}
def main():
    jsonl_path, target_dir = sys.argv[1], sys.argv[2]
    enc = os.environ.get('PAPERCUP_TARGET_ENCODING', 'cp932').strip() or 'cp932'
    by_idx = {}
    for line in open(jsonl_path, 'r', encoding='utf-8'):
        if not line.strip(): continue
        row = json.loads(line)
        by_idx[int(row['line']) - 1] = row['target']

    text_path = os.path.join(target_dir, 'TEXT.DAT')
    vm_path = os.path.join(target_dir, 'SCRIPT.VM')
    entries = parse_text_dat(text_path)
    instrs = parse_vm(vm_path)

    new_pool = bytearray()
    old_to_new = {}
    for idx, (old_off, raw_b) in enumerate(entries):
        old_to_new[old_off] = len(new_pool)
        out_b = by_idx[idx].encode(enc) if idx in by_idx else raw_b
        new_pool += out_b + b'\\x00'

    vm_out = bytearray(b'VM01' + struct.pack('<I', len(instrs)))
    for op, arg0, operand in instrs:
        if op in TEXT_OPS:
            assert operand in old_to_new, f'unmapped text offset {operand}'
            operand = old_to_new[operand]
        vm_out += struct.pack('<HHI', op, arg0, operand)

    with open(text_path, 'wb') as f:
        f.write(new_pool)
    with open(vm_path, 'wb') as f:
        f.write(vm_out)

if __name__ == '__main__':
    main()
`;

/* ========================= L6 Oracle ========================= */

const L6_GPK3_PY = `
def lcg_xor(data: bytes, seed: int) -> bytes:
    st = seed & 0xFFFFFFFF
    out = bytearray(len(data))
    for i, b in enumerate(data):
        st = (st * 1664525 + 1013904223) & 0xFFFFFFFF
        out[i] = b ^ ((st >> 24) & 0xFF)
    return bytes(out)
`;

const L6_UNPACK = `${PY_HEADER}${L6_GPK3_PY}
def main():
    arc, out_dir = sys.argv[1], sys.argv[2]
    data = open(arc, 'rb').read()
    assert data[:4] == b'GPK3'
    seed, count, toc_len = struct.unpack_from('<III', data, 4)
    toc = lcg_xor(data[16:16+toc_len], seed)
    body_start = 16 + toc_len
    pos = 0
    os.makedirs(out_dir, exist_ok=True)
    for i in range(count):
        nlen = struct.unpack_from('<H', toc, pos)[0]; pos += 2
        name = toc[pos:pos+nlen].decode('ascii'); pos += nlen
        off, clen, ulen = struct.unpack_from('<III', toc, pos); pos += 12
        dec = lcg_xor(data[body_start+off:body_start+off+clen], (seed + i + 1) & 0xFFFFFFFF)
        raw = zlib.decompress(dec)
        assert len(raw) == ulen
        dst = os.path.join(out_dir, *name.split('/'))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, 'wb') as f:
            f.write(raw)

if __name__ == '__main__':
    main()
`;

const L6_REPACK = `${PY_HEADER}${L6_GPK3_PY}
SKIP_FILES = {'.papercup-skill-manifest.json'}

def main():
    src_dir, out_arc = sys.argv[1], sys.argv[2]
    seed = 0x20261122
    entries = []
    for root, _, files in os.walk(src_dir):
        for fn in sorted(files):
            if fn in SKIP_FILES or fn.endswith('.bak'):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, src_dir).replace('\\\\', '/')
            entries.append((rel, open(full, 'rb').read()))
    entries.sort(key=lambda x: x[0])
    toc = bytearray()
    payloads = []
    rel_off = 0
    for i, (n, raw) in enumerate(entries):
        comp = zlib.compress(raw)
        enc = lcg_xor(comp, (seed + i + 1) & 0xFFFFFFFF)
        nb = n.encode('ascii')
        toc += struct.pack('<H', len(nb)) + nb + struct.pack('<III', rel_off, len(enc), len(raw))
        payloads.append(enc)
        rel_off += len(enc)
    enc_toc = lcg_xor(bytes(toc), seed)
    os.makedirs(os.path.dirname(os.path.abspath(out_arc)), exist_ok=True)
    with open(out_arc, 'wb') as f:
        f.write(b'GPK3' + struct.pack('<III', seed, len(entries), len(toc)) + enc_toc)
        for p in payloads:
            f.write(p)

if __name__ == '__main__':
    main()
`;

const L6_COMMON_BIN_PY = `
SCB_TEXT_OPS = {0x0001: 'say', 0x0002: 'name', 0x0003: 'choice'}

def xor_msgb(b: bytes, idx: int) -> bytes:
    key = (idx * 0x1D + 0x53) & 0xFF
    return bytes(x ^ key for x in b)

def decode_any(b: bytes) -> str:
    for enc in ('cp932', 'gbk', 'utf-8'):
        try:
            return b.decode(enc)
        except Exception:
            pass
    return b.decode('cp932', errors='replace')

def parse_scb(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'SCB1'
    p = 4
    assert raw[p:p+4] == b'BCOD'
    bcod_len = struct.unpack_from('<I', raw, p+4)[0]
    bcod = raw[p+8:p+8+bcod_len]; p += 8 + bcod_len
    assert raw[p:p+4] == b'MSGB'
    msgb_len = struct.unpack_from('<I', raw, p+4)[0]
    msgb = raw[p+8:p+8+msgb_len]; p += 8 + msgb_len
    assert raw[p:p+4] == b'DBG0'
    dbg_sec = raw[p:]
    icnt = struct.unpack_from('<I', bcod, 0)[0]
    instrs = [struct.unpack_from('<HHI', bcod, 4 + i * 8) for i in range(icnt)]
    mcnt = struct.unpack_from('<I', msgb, 0)[0]
    recs = []
    mp = 4
    for idx in range(mcnt):
        rel_off = mp - 4
        rlen = struct.unpack_from('<H', msgb, mp)[0]; mp += 2
        recs.append((rel_off, xor_msgb(msgb[mp:mp+rlen], idx)))
        mp += rlen
    return instrs, recs, dbg_sec

def parse_uis(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'UIS1'
    cnt = struct.unpack_from('<I', raw, 4)[0]
    pos = 8
    items = []
    for _ in range(cnt):
        kl = struct.unpack_from('<H', raw, pos)[0]; pos += 2
        k = raw[pos:pos+kl].decode('ascii'); pos += kl
        vl = struct.unpack_from('<H', raw, pos)[0]; pos += 2
        v = raw[pos:pos+vl]; pos += vl
        items.append((k, v))
    return items
`;

const L6_EXTRACT = `${PY_HEADER}${L6_COMMON_BIN_PY}
def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    rows = []
    for root, _, files in os.walk(in_dir):
        for fn in sorted(files):
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, in_dir).replace('\\\\', '/')
            if rel.endswith('.scb'):
                instrs, recs, _ = parse_scb(full)
                kind_by_off = {}
                for op, _, operand in instrs:
                    if op in SCB_TEXT_OPS and operand not in kind_by_off:
                        kind_by_off[operand] = SCB_TEXT_OPS[op]
                for idx, (off, plain_b) in enumerate(recs):
                    rows.append({
                        'id': f'scb_{idx:04d}',
                        'file': rel,
                        'line': idx + 1,
                        'kind': kind_by_off.get(off, 'say'),
                        'source': decode_any(plain_b),
                    })
            elif rel.endswith('strings.bin'):
                items = parse_uis(full)
                for idx, (k, vb) in enumerate(items):
                    rows.append({
                        'id': f'uis_{idx:04d}',
                        'file': rel,
                        'line': idx + 1,
                        'kind': 'system',
                        'source': decode_any(vb),
                    })
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')

if __name__ == '__main__':
    main()
`;

const L6_APPLY = `${PY_HEADER}${L6_COMMON_BIN_PY}
def main():
    jsonl_path, target_dir = sys.argv[1], sys.argv[2]
    enc = os.environ.get('PAPERCUP_TARGET_ENCODING', 'cp932').strip() or 'cp932'
    by_file = {}
    for line in open(jsonl_path, 'r', encoding='utf-8'):
        if not line.strip(): continue
        row = json.loads(line)
        by_file.setdefault(row['file'], {})[int(row['line']) - 1] = row['target']

    for rel, idx_map in by_file.items():
        full = os.path.join(target_dir, *rel.split('/'))
        if rel.endswith('.scb'):
            instrs, recs, dbg_sec = parse_scb(full)
            new_msgb_body = bytearray()
            old_to_new = {}
            for idx, (old_off, plain_b) in enumerate(recs):
                old_to_new[old_off] = len(new_msgb_body)
                out_plain = idx_map[idx].encode(enc) if idx in idx_map else plain_b
                enc_b = xor_msgb(out_plain, idx)
                new_msgb_body += struct.pack('<H', len(enc_b)) + enc_b
            msgb_payload = struct.pack('<I', len(recs)) + bytes(new_msgb_body)

            bcod_payload = bytearray(struct.pack('<I', len(instrs)))
            for op, arg0, operand in instrs:
                if op in SCB_TEXT_OPS:
                    assert operand in old_to_new, f'unmapped MSGB offset {operand}'
                    operand = old_to_new[operand]
                bcod_payload += struct.pack('<HHI', op, arg0, operand)

            out = (
                b'SCB1'
                + b'BCOD' + struct.pack('<I', len(bcod_payload)) + bytes(bcod_payload)
                + b'MSGB' + struct.pack('<I', len(msgb_payload)) + msgb_payload
                + dbg_sec
            )
            with open(full, 'wb') as f:
                f.write(out)
        elif rel.endswith('strings.bin'):
            items = parse_uis(full)
            out = bytearray(b'UIS1' + struct.pack('<I', len(items)))
            for idx, (k, vb) in enumerate(items):
                kb = k.encode('ascii')
                nv = idx_map[idx].encode(enc) if idx in idx_map else vb
                out += struct.pack('<H', len(kb)) + kb + struct.pack('<H', len(nv)) + nv
            with open(full, 'wb') as f:
                f.write(out)

if __name__ == '__main__':
    main()
`;

const ORACLES: Record<string, OracleSpec> = {
  'L1-plain-archive': {
    engine: 'vp1-oracle',
    pipeline: 'skill',
    archive: 'game/data.vp1',
    suffix: '.vp1',
    magicHex: '56503100',
    encoding: 'utf-8',
    rasterUiAssets: ['img/title_btn.png'],
    scripts: { unpack: L1_UNPACK, repack: L1_REPACK, extract: L1_EXTRACT, apply: L1_APPLY },
    layoutMd: '# L1 VP1 Layout\n- Archive: `game/data.vp1` (`VP1\\0`, u32 count, TOC entries `{u16 nameLen, utf8 name, u32 offset, u32 size}`)\n- Raster UI: `img/title_btn.png`\n',
    hypothesesMd: '# L1 Hypotheses\n- H1 [confirmed]: `script/ch01.vsc` uses `say "..."`, `@name ...`, `#choice ...`.\n- H2 [confirmed]: `ui/menu.json` stores UI labels under `labels`.\n',
    textMappingJson: { engine: 'vp1-oracle', encoding: 'utf-8', raster_ui: ['img/title_btn.png'] },
  },
  'L2-cp932-xor-archive': {
    engine: 'xpk2-oracle',
    pipeline: 'skill',
    archive: 'game/story.xpk',
    suffix: '.xpk',
    magicHex: '58504b32',
    encoding: 'cp932',
    controlPattern: '<C#[0-9A-Fa-f]{6}>|</C>|%[A-Za-z_]+%|\\\\n',
    scripts: { unpack: L2_UNPACK, repack: L2_REPACK, extract: L2_EXTRACT, apply: L2_APPLY },
    layoutMd: '# L2 XPK2 Layout\n- Archive: `game/story.xpk` (`XPK2`, u32 seed, u32 count, u32 tocLen, XOR TOC `(seed + i*17)&0xFF`, XOR body `(seed+1 + i*17)&0xFF`)\n',
    hypothesesMd: '# L2 Hypotheses\n- H1 [confirmed]: Disassembled `xpk_player.exe` confirming stride `0x11` and `+1` body seed.\n- H2 [confirmed]: Inline tags `<C#RRGGBB>...</C>`, `%player%`, `\\n`.\n',
    textMappingJson: { engine: 'xpk2-oracle', encoding: 'cp932', control_pattern: '<C#[0-9A-Fa-f]{6}>|</C>|%[A-Za-z_]+%|\\\\n' },
  },
  'L3-halfwidth-kana-direct': {
    engine: 'bscr-oracle',
    pipeline: 'direct',
    unpackedDir: 'game',
    encoding: 'cp932',
    scripts: { extract: L3_EXTRACT, apply: L3_APPLY },
    layoutMd: '# L3 BSCR Layout\n- Single file `game/scenario.bscr`: `BSCR` + ver + ulen + clen + zlib payload.\n- Records: `{u32 id, u8 kind, u16 len, bytes}`; kind 1..4 are player text, kind 9 are internal keys.\n',
    hypothesesMd: '# L3 Hypotheses\n- H1 [confirmed]: Player text is CP932 half-width katakana compressed; `extract.py` normalizes to full-width.\n',
    textMappingJson: { engine: 'bscr-oracle', encoding: 'cp932', internal_kind_code: 9 },
  },
  'L4-obfuscated-msg-trap': {
    engine: 'cbin-oracle',
    pipeline: 'direct',
    unpackedDir: 'game',
    encoding: 'cp932',
    scripts: { extract: L4_EXTRACT, apply: L4_APPLY },
    layoutMd: '# L4 CBIN Layout\n- `game/trial.cbin`: `CBIN` + ulen + clen + zlib(`STR0` + `MSG1` + `TAIL`).\n- `STR0` has 50 decoy lookup keys + 4 real UI prompts; `MSG1` has 40 obfuscated story/name records.\n',
    hypothesesMd: '# L4 Hypotheses\n- H1 [confirmed]: Disassembled `trial.exe` at `MSG1` xref: `((b ^ 0xA5) - 0x47 - j) & 0xFF`.\n',
    textMappingJson: { engine: 'cbin-oracle', encoding: 'cp932', sections: ['STR0', 'MSG1'] },
  },
  'L5-pointer-relocation-vm': {
    engine: 'vm01-oracle',
    pipeline: 'direct',
    unpackedDir: 'game',
    encoding: 'cp932',
    scripts: { extract: L5_EXTRACT, apply: L5_APPLY },
    layoutMd: '# L5 VM01 Layout\n- `game/TEXT.DAT`: NUL-terminated CP932 string pool.\n- `game/SCRIPT.VM`: `VM01` + count + `{u16 opcode, u16 arg0, u32 operand}`.\n',
    hypothesesMd: '# L5 Hypotheses\n- H1 [confirmed]: Disassembled `vm_engine.exe`: opcodes `0x10..0x13` dereference `TEXT.DAT + operand`; `0x20..0x22` are non-text integer operands.\n',
    textMappingJson: { engine: 'vm01-oracle', encoding: 'cp932', text_opcodes: [16, 17, 18, 19] },
  },
  'L6-full-gauntlet': {
    engine: 'gpk3-oracle',
    pipeline: 'skill',
    archive: 'game/data_scn.pak',
    suffix: '.pak',
    magicHex: '47504b33',
    encoding: 'cp932',
    controlPattern: '<ruby\\s+[^>]+/>|%[0-9]*[diouxXs]|\\\\n',
    rasterUiAssets: ['ui/title_menu.png'],
    scripts: { unpack: L6_UNPACK, repack: L6_REPACK, extract: L6_EXTRACT, apply: L6_APPLY },
    layoutMd: '# L6 GPK3/SCB1/UIS1 Layout\n- Dual archives: `data_scn.pak`, `data_sys.pak` (`GPK3` LCG `1664525/1013904223` + zlib).\n- `SCB1` has `BCOD` (byte offsets into `MSGB`), `MSGB` (`(idx*0x1D+0x53)&0xFF` XOR), `DBG0` decoy.\n- `UIS1` key/value table + `ui/title_menu.png` raster UI.\n',
    hypothesesMd: '# L6 Hypotheses\n- H1 [confirmed]: Disassembled `gauntlet.exe` for GPK3 LCG, MSGB per-record XOR, and BCOD opcodes `0x01..0x03` vs `0x09`.\n',
    textMappingJson: { engine: 'gpk3-oracle', encoding: 'cp932', raster_ui: ['ui/title_menu.png'] },
  },
};

export async function runOracleForTask(
  task: BenchTaskSpec,
  workspaceDir: string,
  homeDir: string
): Promise<void> {
  const spec = ORACLES[task.id];
  if (!spec) throw new Error(`未找到题目 ${task.id} 的参考 Oracle 实现`);

  const researchDir = path.join(workspaceDir, '.papercup', 'research', spec.engine);
  const scriptsDir = path.join(researchDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(researchDir, '01-layout.md'), spec.layoutMd, 'utf8');
  fs.writeFileSync(path.join(researchDir, '02-hypotheses.md'), spec.hypothesesMd, 'utf8');
  fs.writeFileSync(
    path.join(researchDir, '03-text-mapping.json'),
    JSON.stringify(spec.textMappingJson, null, 2) + '\n',
    'utf8'
  );

  const extractPath = path.join(scriptsDir, 'extract.py');
  const applyPath = path.join(scriptsDir, 'apply.py');
  fs.writeFileSync(extractPath, spec.scripts.extract, 'utf8');
  fs.writeFileSync(applyPath, spec.scripts.apply, 'utf8');

  let unpackPath: string | undefined;
  let repackPath: string | undefined;
  if (spec.pipeline === 'skill') {
    unpackPath = path.join(scriptsDir, 'unpack.py');
    repackPath = path.join(scriptsDir, 'repack.py');
    fs.writeFileSync(unpackPath, spec.scripts.unpack!, 'utf8');
    fs.writeFileSync(repackPath, spec.scripts.repack!, 'utf8');
  }

  const res = await learnUnpackSkill(workspaceDir, {
    homeDir,
    engine: spec.engine,
    pipeline: spec.pipeline,
    archive: spec.archive,
    unpackedDir: spec.unpackedDir,
    unpackScript: unpackPath ? path.relative(workspaceDir, unpackPath).replace(/\\/g, '/') : undefined,
    repackScript: repackPath ? path.relative(workspaceDir, repackPath).replace(/\\/g, '/') : undefined,
    extractScript: path.relative(workspaceDir, extractPath).replace(/\\/g, '/'),
    applyScript: path.relative(workspaceDir, applyPath).replace(/\\/g, '/'),
    suffix: spec.suffix,
    magicHex: spec.magicHex,
    encoding: spec.encoding,
    controlPattern: spec.controlPattern,
    rasterUiAssets: spec.rasterUiAssets,
    requireWriteback: true,
    overwrite: true,
    note: `Reference oracle solution for ${task.id}`,
  });
  if (res.status !== 'adopted') {
    throw new Error(`Oracle learnUnpackSkill 未采纳 (${res.status}): ${res.summary}`);
  }
}

export interface AdversarialCheckResult {
  name: string;
  taskId: string;
  caught: boolean;
  detail: string;
}

/**
 * Runs 5 adversarial negative tests to prove that Paper Cup's `learnUnpackSkill`
 * and the benchmark's 8-gate grader strictly reject common cheating / broken solutions.
 */
export async function runAdversarialChecks(): Promise<AdversarialCheckResult[]> {
  const results: AdversarialCheckResult[] = [];
  const taskById = new Map(BENCH_TASKS.map((t) => [t.id, t]));

  const withIsolatedEnv = async (
    taskId: string,
    fn: (task: BenchTaskSpec, ws: string, home: string, snap: Map<string, string>) => Promise<{ caught: boolean; detail: string }>
  ): Promise<AdversarialCheckResult> => {
    const task = taskById.get(taskId)!;
    const base = fs.mkdtempSync(path.join(os.tmpdir(), `papercup-bench-adv-${task.difficulty}-`));
    const ws = path.join(base, 'ws');
    const home = path.join(base, 'home');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    try {
      task.generateFixture(ws);
      const snap = snapshotDirSha256(path.join(ws, task.gameRelDir));
      const res = await fn(task, ws, home, snap);
      return { name: '', taskId, ...res };
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  };

  // ADV1: `_WB`-only cheat apply.py on L1 MUST be rejected by learnUnpackSkill
  {
    const r = await withIsolatedEnv('L1-plain-archive', async (_task, ws, home) => {
      const spec = ORACLES['L1-plain-archive'];
      const dir = path.join(ws, '.papercup', 'research', 'adv1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'unpack.py'), spec.scripts.unpack!, 'utf8');
      fs.writeFileSync(path.join(dir, 'repack.py'), spec.scripts.repack!, 'utf8');
      fs.writeFileSync(path.join(dir, 'extract.py'), spec.scripts.extract, 'utf8');
      // Cheating apply.py: only applies rows ending in _WB, ignores real translations!
      const cheatApply = spec.scripts.apply.replace(
        "by_file.setdefault(row['file'], []).append(row)",
        "if str(row.get('target', '')).endswith('_WB'): by_file.setdefault(row['file'], []).append(row)"
      );
      fs.writeFileSync(path.join(dir, 'apply.py'), cheatApply, 'utf8');
      const learnRes = await learnUnpackSkill(ws, {
        homeDir: home,
        engine: 'adv1-cheat',
        pipeline: 'skill',
        archive: 'game/data.vp1',
        unpackScript: '.papercup/research/adv1/unpack.py',
        repackScript: '.papercup/research/adv1/repack.py',
        extractScript: '.papercup/research/adv1/extract.py',
        applyScript: '.papercup/research/adv1/apply.py',
        suffix: '.vp1',
        magicHex: '56503100',
        encoding: 'utf-8',
        requireWriteback: true,
      });
      if (learnRes.status === 'adopted') {
        return { caught: false, detail: '严重漏洞：仅匹配 _WB 后缀的作弊 apply.py 竟通过了 learnUnpackSkill！' };
      }
      return { caught: true, detail: `learnUnpackSkill 成功拦截作弊 apply.py：${learnRes.summary.slice(0, 140)}` };
    });
    results.push({ ...r, name: 'ADV1_WB_ONLY_CHEAT' });
  }

  // ADV2: Undecoded half-width katakana on L3 MUST fail G4_EXTRACTION_ACCURACY
  {
    const r = await withIsolatedEnv('L3-halfwidth-kana-direct', async (task, ws, home, snap) => {
      const spec = ORACLES['L3-halfwidth-kana-direct'];
      const dir = path.join(ws, '.papercup', 'research', 'adv2');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-layout.md'), spec.layoutMd, 'utf8');
      fs.writeFileSync(path.join(dir, '02-hypotheses.md'), spec.hypothesesMd, 'utf8');
      fs.writeFileSync(path.join(dir, '03-text-mapping.json'), '{}\n', 'utf8');
      const badExtract = spec.scripts.extract.replace('text = hw_to_fw(decode_payload(payload))', 'text = decode_payload(payload)');
      fs.writeFileSync(path.join(dir, 'extract.py'), badExtract, 'utf8');
      fs.writeFileSync(path.join(dir, 'apply.py'), spec.scripts.apply, 'utf8');
      const learnRes = await learnUnpackSkill(ws, {
        homeDir: home,
        engine: 'adv2',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/research/adv2/extract.py',
        applyScript: '.papercup/research/adv2/apply.py',
        encoding: 'cp932',
        requireWriteback: true,
      });
      if (learnRes.status !== 'adopted') {
        return { caught: false, detail: `ADV2 前置采纳意外失败（未能测到 G4）: ${learnRes.summary}` };
      }
      const gates = await gradeReverserRun({ task, workspaceDir: ws, homeDir: home, originalGameSnapshot: snap });
      const g4 = gates.find((g) => g.id === 'G4_EXTRACTION_ACCURACY')!;
      return {
        caught: !g4.passed,
        detail: !g4.passed ? `G4 成功拦截未还原半角片假名：${g4.summary.slice(0, 140)}` : '漏洞：未还原半角片假名竟通过了 G4',
      };
    });
    results.push({ ...r, name: 'ADV2_UNDECODED_HALFWIDTH_KANA' });
  }

  // ADV3a: Naive STR0 bulk dumper (54 UI/decoy rows, 0 MSG1 scenario rows) MUST be rejected by learnUnpackSkill low-scenario gate
  {
    const r = await withIsolatedEnv('L4-obfuscated-msg-trap', async (_task, ws, home) => {
      const dir = path.join(ws, '.papercup', 'research', 'adv3a');
      fs.mkdirSync(dir, { recursive: true });
      const decoyBulkExtract = `${PY_HEADER}${L4_COMMON_PY}
def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    _, str0, _, _ = parse_cbin(os.path.join(in_dir, 'trial.cbin'))
    rows = []
    for i, b in enumerate(str0):
        txt = decode_any(b)
        if txt:
            rows.append({'id': f'str0_{i:04d}', 'file': 'trial.cbin', 'line': 2000 + i, 'kind': 'system', 'source': txt})
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')
if __name__ == '__main__': main()
`;
      fs.writeFileSync(path.join(dir, 'extract.py'), decoyBulkExtract, 'utf8');
      fs.writeFileSync(path.join(dir, 'apply.py'), L4_APPLY, 'utf8');
      const learnRes = await learnUnpackSkill(ws, {
        homeDir: home,
        engine: 'adv3a',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/research/adv3a/extract.py',
        applyScript: '.papercup/research/adv3a/apply.py',
        encoding: 'cp932',
        requireWriteback: true,
      });
      if (learnRes.status === 'adopted') {
        return { caught: false, detail: '漏洞：只抽 STR0（54 条非剧情、0 条剧情）竟通过了 learnUnpackSkill！' };
      }
      return { caught: true, detail: `learnUnpackSkill 低剧情门禁成功拦截仅抽 STR0 诱饵：${learnRes.summary.slice(0, 140)}` };
    });
    results.push({ ...r, name: 'ADV3A_DECOY_STR0_BULK_DUMP' });
  }

  // ADV3b: Filtered STR0-only extractor (4 real UI prompts, 0 MSG1 scenario lines) MUST FAIL G4_EXTRACTION_ACCURACY
  {
    const r = await withIsolatedEnv('L4-obfuscated-msg-trap', async (task, ws, home, snap) => {
      const spec = ORACLES['L4-obfuscated-msg-trap'];
      const dir = path.join(ws, '.papercup', 'research', 'adv3b');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-layout.md'), spec.layoutMd, 'utf8');
      fs.writeFileSync(path.join(dir, '02-hypotheses.md'), spec.hypothesesMd, 'utf8');
      fs.writeFileSync(path.join(dir, '03-text-mapping.json'), '{}\n', 'utf8');
      const decoyFilteredExtract = `${PY_HEADER}${L4_COMMON_PY}
def main():
    in_dir, out_jsonl = sys.argv[1], sys.argv[2]
    _, str0, _, _ = parse_cbin(os.path.join(in_dir, 'trial.cbin'))
    rows = []
    for i, b in enumerate(str0):
        txt = decode_any(b)
        if is_real_ui_str0(txt):
            rows.append({'id': f'str0_{i:04d}', 'file': 'trial.cbin', 'line': 2000 + i, 'kind': 'system', 'source': txt})
    with open(out_jsonl, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\\n')
if __name__ == '__main__': main()
`;
      fs.writeFileSync(path.join(dir, 'extract.py'), decoyFilteredExtract, 'utf8');
      fs.writeFileSync(path.join(dir, 'apply.py'), L4_APPLY, 'utf8');
      const learnRes = await learnUnpackSkill(ws, {
        homeDir: home,
        engine: 'adv3b',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/research/adv3b/extract.py',
        applyScript: '.papercup/research/adv3b/apply.py',
        encoding: 'cp932',
        requireWriteback: true,
      });
      if (learnRes.status !== 'adopted') {
        return { caught: true, detail: `learnUnpackSkill 直接拦截: ${learnRes.summary.slice(0, 120)}` };
      }
      const gates = await gradeReverserRun({ task, workspaceDir: ws, homeDir: home, originalGameSnapshot: snap });
      const g4 = gates.find((g) => g.id === 'G4_EXTRACTION_ACCURACY')!;
      return {
        caught: !g4.passed,
        detail: !g4.passed ? `G4 成功拦截漏抽混淆 MSG1（仅抽 4 条 STR0 UI）：${g4.summary.slice(0, 140)}` : '漏洞：0/36 剧情竟通过了 G4！',
      };
    });
    results.push({ ...r, name: 'ADV3B_DECOY_STR0_FILTERED_ONLY' });
  }

  // ADV4: Blind global u32 offset replacement on L5 MUST FAIL G6 VM simulator
  {
    const r = await withIsolatedEnv('L5-pointer-relocation-vm', async (task, ws, home, snap) => {
      const spec = ORACLES['L5-pointer-relocation-vm'];
      const dir = path.join(ws, '.papercup', 'research', 'adv4');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-layout.md'), spec.layoutMd, 'utf8');
      fs.writeFileSync(path.join(dir, '02-hypotheses.md'), spec.hypothesesMd, 'utf8');
      fs.writeFileSync(path.join(dir, '03-text-mapping.json'), '{}\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'extract.py'), spec.scripts.extract, 'utf8');
      // Blindly replace EVERY operand that happens to match an old TEXT.DAT offset, ignoring opcode!
      const blindApply = spec.scripts.apply.replace(
        'if op in TEXT_OPS:\n            assert operand in old_to_new, f\'unmapped text offset {operand}\'\n            operand = old_to_new[operand]',
        'if operand in old_to_new:\n            operand = old_to_new[operand]'
      );
      fs.writeFileSync(path.join(dir, 'apply.py'), blindApply, 'utf8');
      await learnUnpackSkill(ws, {
        homeDir: home,
        engine: 'adv4',
        pipeline: 'direct',
        unpackedDir: 'game',
        extractScript: '.papercup/research/adv4/extract.py',
        applyScript: '.papercup/research/adv4/apply.py',
        encoding: 'cp932',
        requireWriteback: true,
      });
      const gates = await gradeReverserRun({ task, workspaceDir: ws, homeDir: home, originalGameSnapshot: snap });
      const g6 = gates.find((g) => g.id === 'G6_VARIABLE_LENGTH_ZH_WRITEBACK')!;
      return {
        caught: !g6.passed,
        detail: !g6.passed ? `G6 VM 模拟器成功拦截盲目全局 u32 替换：${g6.summary.slice(0, 120)}` : '漏洞：盲目全局 u32 替换竟通过了 G6！',
      };
    });
    results.push({ ...r, name: 'ADV4_BLIND_U32_PATCHER' });
  }

  // ADV5: Missing control_pattern on L6 MUST FAIL G7_CONTROL_PATTERN_QA
  {
    const r = await withIsolatedEnv('L6-full-gauntlet', async (task, ws, home, snap) => {
      const spec = ORACLES['L6-full-gauntlet'];
      const dir = path.join(ws, '.papercup', 'research', 'adv5');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '01-layout.md'), spec.layoutMd, 'utf8');
      fs.writeFileSync(path.join(dir, '02-hypotheses.md'), spec.hypothesesMd, 'utf8');
      fs.writeFileSync(path.join(dir, '03-text-mapping.json'), '{}\n', 'utf8');
      fs.writeFileSync(path.join(dir, 'unpack.py'), spec.scripts.unpack!, 'utf8');
      fs.writeFileSync(path.join(dir, 'repack.py'), spec.scripts.repack!, 'utf8');
      fs.writeFileSync(path.join(dir, 'extract.py'), spec.scripts.extract, 'utf8');
      fs.writeFileSync(path.join(dir, 'apply.py'), spec.scripts.apply, 'utf8');
      await learnUnpackSkill(ws, {
        homeDir: home,
        engine: 'adv5',
        pipeline: 'skill',
        archive: 'game/data_scn.pak',
        unpackScript: '.papercup/research/adv5/unpack.py',
        repackScript: '.papercup/research/adv5/repack.py',
        extractScript: '.papercup/research/adv5/extract.py',
        applyScript: '.papercup/research/adv5/apply.py',
        suffix: '.pak',
        magicHex: '47504b33',
        encoding: 'cp932',
        rasterUiAssets: spec.rasterUiAssets,
        // Deliberately omit controlPattern!
        requireWriteback: true,
      });
      const gates = await gradeReverserRun({ task, workspaceDir: ws, homeDir: home, originalGameSnapshot: snap });
      const g7 = gates.find((g) => g.id === 'G7_CONTROL_PATTERN_QA')!;
      return {
        caught: !g7.passed,
        detail: !g7.passed ? `G7 成功拦截漏报自定义控制标签正则：${g7.summary.slice(0, 120)}` : '漏洞：未注册 control_pattern 竟通过了 G7！',
      };
    });
    results.push({ ...r, name: 'ADV5_MISSING_CONTROL_PATTERN' });
  }

  return results;
}
