#!/usr/bin/env python3
"""NeXAS PACF script (.binu8 / .bin) and language table (.lngt) text extractor.

Supports:
- NeXAS .binu8 / .bin compiled scripts with 0x1C text pool (headered 0x1C pool,
  chunk-tagged 0x1C pool, VER\\x00 + code stream + pool, or direct code stream + pool)
- NeXAS .lngt UI/system language tables (UTF-8 / UTF-8-BOM / CP932)

Guarantees:
- Emits strict Paper Cup JSONL (id, file, line >= 1, scene, speaker, kind, source)
- Automatically filters script jump targets matching unpacked TOC filenames or
  extensionless stems (even when containing Japanese characters)
- Filters non-player media assets, internal identifiers, and widget lookup logs
- Writes zero sidecar files into <unpacked_dir>
"""

import json
import os
import re
import struct
import sys

BIN_SCRIPT_EXTS = (".binu8", ".bin")
LNGT_EXTS = (".lngt",)
TEXT_POOL_TAG = 0x1C
HEADER_0X1C_SIZE = 0x1C

ASSET_EXT_RE = re.compile(
    r"\.(?:png|jpg|jpeg|bmp|tga|dds|webp|psd|ogg|wav|mp3|flac|mpg|mpeg|wmv|mp4|avi|webm|pac|xp3|rpa|nsa|binu8|bin|lngt|ini|cfg|json|txt|csv|dll|exe|ttf|otf|fnt|cur|ico)$",
    re.IGNORECASE,
)
PURE_ASCII_IDENT_RE = re.compile(r"^[A-Za-z0-9_./:\\-]+$")
WIDGET_LOOKUP_RE = re.compile(
    r"(?:\b(?:GetPanel|GetButton|GetForm|GetControl|GetWindow|FindChild|LoadScene|CallScript)\s*\(|^[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*)"
)
ONLY_CONTROL_OR_PUNCT_RE = re.compile(
    r"^(?:\s|@r[^@]+@[^@]+@|@[A-Za-z](?![A-Za-z])|<[^>]+>|[0-9A-Za-z_.,:;!?+\-*/=()\[\]{}\"'\\/|~`@#$%^&])+$"
)
HAS_CJK_OR_KANA_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]")


def _read_cstr_pool(data: bytes, offset: int, count: int, limit: int, encoding: str) -> tuple[list[tuple[int, int, str]], int] | None:
    if count < 0 or count > 200000 or offset < 0 or offset > limit:
        return None
    pos = offset
    entries: list[tuple[int, int, str]] = []
    for _ in range(count):
        if pos >= limit:
            return None
        nul = data.find(b"\x00", pos, limit)
        if nul < 0:
            return None
        raw = data[pos:nul]
        try:
            text = raw.decode(encoding)
        except UnicodeDecodeError:
            if encoding == "utf-8":
                try:
                    text = raw.decode("cp932")
                except UnicodeDecodeError:
                    return None
            else:
                return None
        entries.append((pos, nul, text))
        pos = nul + 1
    return entries, pos


def parse_nexas_bin_script(data: bytes, is_utf8: bool = True) -> dict | None:
    """Parse a NeXAS .binu8/.bin file and locate its string pool deterministically.

    Returns a dict describing the layout and decoded string pool, or None if not recognized.
    """
    encoding = "utf-8" if is_utf8 else "cp932"
    total = len(data)
    if total < 8:
        return None

    # Layout 1: 0x1C-byte headered text pool (header_size == 0x1C)
    # <IIIIIII: header_size(0x1C), version, code_offset, code_count, pool_offset, pool_count, pool_size
    if total >= HEADER_0X1C_SIZE:
        hdr_size, _ver, code_off, code_cnt, pool_off, pool_cnt, pool_size = struct.unpack_from("<7I", data, 0)
        if (
            hdr_size == HEADER_0X1C_SIZE
            and code_off >= HEADER_0X1C_SIZE
            and code_off + code_cnt * 8 <= total
            and pool_off >= HEADER_0X1C_SIZE
            and pool_off + pool_size <= total
        ):
            parsed = _read_cstr_pool(data, pool_off, pool_cnt, pool_off + pool_size, encoding)
            if parsed is not None:
                entries, end_pos = parsed
                if end_pos == pool_off + pool_size:
                    return {
                        "layout": "header_0x1c",
                        "encoding": encoding,
                        "pool_offset": pool_off,
                        "pool_end": end_pos,
                        "entries": entries,
                    }

    # Layout 2: Chunk-tagged container containing chunk tag 0x1C (tag: u32, size: u32, payload)
    if total >= 12:
        pos = 0
        chunk_ok = True
        found_chunk = None
        chunks_seen = 0
        while pos + 8 <= total and chunks_seen < 64:
            tag, size = struct.unpack_from("<II", data, pos)
            if pos + 8 + size > total or tag == 0 or tag > 0xFFFF:
                chunk_ok = False
                break
            if tag == TEXT_POOL_TAG and size >= 4:
                cnt = struct.unpack_from("<I", data, pos + 8)[0]
                parsed = _read_cstr_pool(data, pos + 12, cnt, pos + 8 + size, encoding)
                if parsed is not None and parsed[1] == pos + 8 + size:
                    found_chunk = {
                        "layout": "chunk_0x1c",
                        "encoding": encoding,
                        "chunk_offset": pos,
                        "pool_offset": pos + 12,
                        "pool_end": pos + 8 + size,
                        "entries": parsed[0],
                    }
            pos += 8 + size
            chunks_seen += 1
        if chunk_ok and pos == total and found_chunk is not None:
            return found_chunk

    # Layout 3: VER\x00 + uint32 version + code_count + code_count*8 + str_count + cstr pool
    if data[:4] == b"VER\x00" and total >= 16:
        code_cnt = struct.unpack_from("<I", data, 8)[0]
        pool_hdr = 12 + code_cnt * 8
        if pool_hdr + 4 <= total:
            str_cnt = struct.unpack_from("<I", data, pool_hdr)[0]
            parsed = _read_cstr_pool(data, pool_hdr + 4, str_cnt, total, encoding)
            if parsed is not None:
                return {
                    "layout": "ver_code_pool",
                    "encoding": encoding,
                    "pool_offset": pool_hdr + 4,
                    "pool_end": parsed[1],
                    "entries": parsed[0],
                }

    # Layout 4: Direct code_count + code_count*8 + str_count + cstr pool
    code_cnt = struct.unpack_from("<I", data, 0)[0]
    pool_hdr = 4 + code_cnt * 8
    if pool_hdr + 4 <= total:
        str_cnt = struct.unpack_from("<I", data, pool_hdr)[0]
        parsed = _read_cstr_pool(data, pool_hdr + 4, str_cnt, total, encoding)
        if parsed is not None:
            return {
                "layout": "direct_code_pool",
                "encoding": encoding,
                "pool_offset": pool_hdr + 4,
                "pool_end": parsed[1],
                "entries": parsed[0],
            }

    return None


def collect_toc_jump_targets(unpacked_dir: str) -> set[str]:
    """Build normalized set of all unpacked filenames, relative paths, and stems.

    Any string matching a TOC filename or stem is a script jump target and must never
    be extracted for translation (translating jump targets causes black screens on scene transitions).
    """
    targets: set[str] = set()
    base = os.path.realpath(unpacked_dir)
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fname in files:
            if fname.startswith(".") or fname.endswith(".bak"):
                continue
            full = os.path.join(root, fname)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, base).replace("\\", "/")
            stem = os.path.splitext(fname)[0]
            rel_no_ext = os.path.splitext(rel)[0]
            for cand in (fname, stem, rel, rel_no_ext):
                cleaned = cand.strip().casefold()
                if cleaned:
                    targets.add(cleaned)
    return targets


def is_translatable_bin_string(text: str, toc_targets: set[str]) -> bool:
    stripped = text.strip()
    if not stripped:
        return False
    # Filter TOC script jump targets (including Japanese scene filenames/stems)
    if stripped.casefold() in toc_targets:
        return False
    norm_slash = stripped.replace("\\", "/").casefold()
    if norm_slash in toc_targets or os.path.splitext(norm_slash)[0] in toc_targets:
        return False
    if ASSET_EXT_RE.search(stripped):
        return False
    if WIDGET_LOOKUP_RE.search(stripped):
        return False
    if PURE_ASCII_IDENT_RE.match(stripped) and " " not in stripped:
        return False
    if ONLY_CONTROL_OR_PUNCT_RE.match(stripped):
        return False
    # Require natural language characters (CJK/kana or multi-word Latin sentence)
    if HAS_CJK_OR_KANA_RE.search(stripped):
        return True
    if " " in stripped and any(ch.isalpha() for ch in stripped):
        return True
    return False


def escape_source_line(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")


def decode_lngt_file(raw: bytes) -> tuple[str, str, str]:
    """Decode .lngt bytes, returning (text, encoding_name, newline_style)."""
    if raw.startswith(b"\xef\xbb\xbf"):
        text = raw[3:].decode("utf-8")
        enc = "utf-8-bom"
    else:
        try:
            text = raw.decode("utf-8")
            enc = "utf-8"
        except UnicodeDecodeError:
            text = raw.decode("cp932")
            enc = "cp932"
    nl = "\r\n" if "\r\n" in text else "\n"
    return text, enc, nl


def extract_dir(unpacked_dir: str, out_jsonl: str) -> list[dict]:
    base = os.path.realpath(unpacked_dir)
    toc_targets = collect_toc_jump_targets(base)
    rows: list[dict] = []

    rel_files: list[tuple[str, str]] = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for fname in sorted(files):
            if fname.startswith(".") or fname.endswith(".bak"):
                continue
            full = os.path.join(root, fname)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, base).replace("\\", "/")
            rel_files.append((rel, full))
    rel_files.sort(key=lambda item: item[0])

    for rel, full in rel_files:
        low = rel.lower()
        scene = os.path.splitext(os.path.basename(rel))[0]
        if low.endswith(BIN_SCRIPT_EXTS):
            with open(full, "rb") as fh:
                data = fh.read()
            parsed = parse_nexas_bin_script(data, is_utf8=low.endswith(".binu8"))
            if parsed is None:
                continue
            for idx, (_start, _end, text) in enumerate(parsed["entries"]):
                if not is_translatable_bin_string(text, toc_targets):
                    continue
                escaped = escape_source_line(text)
                if not escaped.strip():
                    continue
                rows.append({
                    "id": f"{rel}#S{idx}",
                    "file": rel,
                    "line": idx + 1,
                    "scene": scene,
                    "speaker": "",
                    "kind": "say",
                    "source": escaped,
                })
        elif low.endswith(LNGT_EXTS):
            with open(full, "rb") as fh:
                raw = fh.read()
            text, _enc, _nl = decode_lngt_file(raw)
            lines = text.splitlines()
            for line_idx, raw_line in enumerate(lines, start=1):
                stripped = raw_line.strip()
                if not stripped:
                    continue
                if stripped.casefold() in toc_targets or ASSET_EXT_RE.search(stripped):
                    continue
                if WIDGET_LOOKUP_RE.search(stripped):
                    continue
                rows.append({
                    "id": f"{rel}#L{line_idx}",
                    "file": rel,
                    "line": line_idx,
                    "scene": scene,
                    "speaker": "",
                    "kind": "system",
                    "source": escape_source_line(raw_line),
                })

    out_parent = os.path.dirname(os.path.abspath(out_jsonl))
    if out_parent:
        os.makedirs(out_parent, exist_ok=True)
    with open(out_jsonl, "w", encoding="utf-8", newline="\n") as out_fh:
        for row in rows:
            out_fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return rows


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("Usage: extract.py <unpacked_dir> <out_jsonl>\n")
        return 2
    extract_dir(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
