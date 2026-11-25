#!/usr/bin/env python3
"""NeXAS PACF script (.binu8 / .bin) and language table (.lngt) atomic writeback tool.

Contract:
- Usage: apply.py <results_jsonl> <unpacked_dir>
- Always writes row["target"] (falling back to row["source"] only if target is absent/empty).
- Honors PAPERCUP_TARGET_ENCODING (utf-8, utf-8-bom, gbk, cp932, utf-16le-bom) when set.
- Pre-validates all target rows and files in memory before touching disk (2PC).
- Rebuilds .binu8/.bin 0x1C text pool cleanly and updates pool/chunk size headers.
- Preserves .lngt original line endings, BOM, blank lines, and trailing blank line.
- Writes ZERO auxiliary sidecar files (never creates .papercup-*.json).
"""

import json
import os
import struct
import sys

BIN_SCRIPT_EXTS = (".binu8", ".bin")
LNGT_EXTS = (".lngt",)
TEXT_POOL_TAG = 0x1C
HEADER_0X1C_SIZE = 0x1C


def _resolve_target_encoding(default_enc: str, is_binu8: bool) -> str:
    raw = (os.environ.get("PAPERCUP_TARGET_ENCODING") or "").strip().lower()
    if not raw or raw == "auto":
        return "utf-8" if is_binu8 else default_enc
    if raw in ("utf-8", "utf8"):
        return "utf-8"
    if raw in ("utf-8-bom", "utf8-bom", "utf-8-sig"):
        return "utf-8-bom"
    if raw in ("gbk", "cp936", "gb18030"):
        return "gbk"
    if raw in ("cp932", "shift_jis", "shift-jis", "sjis"):
        return "cp932"
    if raw in ("utf-16le-bom", "utf-16le", "utf16le"):
        return "utf-16le-bom"
    return default_enc


def _encode_str(text: str, enc: str) -> bytes:
    if enc == "utf-8-bom":
        return text.encode("utf-8")
    if enc == "utf-16le-bom":
        return text.encode("utf-16le")
    return text.encode(enc)


def _stays_inside(base_dir: str, rel_path: str) -> str:
    norm = rel_path.replace("\\", "/").strip()
    if not norm or "\x00" in norm or norm.startswith("/") or (len(norm) >= 2 and norm[1] == ":"):
        raise ValueError(f"Unsafe target path: {rel_path!r}")
    parts = [p for p in norm.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        raise ValueError(f"Path traversal in target path: {rel_path!r}")
    base = os.path.realpath(base_dir)
    target = os.path.realpath(os.path.join(base, *parts))
    if os.path.commonpath([base, target]) != base or target == base:
        raise ValueError(f"Target path escapes unpacked directory: {rel_path!r}")
    if os.path.islink(target) or not os.path.isfile(target):
        raise FileNotFoundError(f"Target script file missing or symlink: {rel_path!r}")
    return target


def _read_cstr_pool_raw(data: bytes, offset: int, count: int, limit: int) -> tuple[list[bytes], int] | None:
    if count < 0 or count > 200000 or offset < 0 or offset > limit:
        return None
    pos = offset
    raws: list[bytes] = []
    for _ in range(count):
        if pos >= limit:
            return None
        nul = data.find(b"\x00", pos, limit)
        if nul < 0:
            return None
        raws.append(data[pos:nul])
        pos = nul + 1
    return raws, pos


def _locate_bin_pool(data: bytes) -> dict | None:
    total = len(data)
    if total < 8:
        return None

    # Layout 1: 0x1C-byte headered text pool
    if total >= HEADER_0X1C_SIZE:
        hdr_size, _ver, code_off, code_cnt, pool_off, pool_cnt, pool_size = struct.unpack_from("<7I", data, 0)
        if (
            hdr_size == HEADER_0X1C_SIZE
            and code_off >= HEADER_0X1C_SIZE
            and code_off + code_cnt * 8 <= total
            and pool_off >= HEADER_0X1C_SIZE
            and pool_off + pool_size <= total
        ):
            parsed = _read_cstr_pool_raw(data, pool_off, pool_cnt, pool_off + pool_size)
            if parsed is not None and parsed[1] == pool_off + pool_size:
                return {
                    "layout": "header_0x1c",
                    "pool_offset": pool_off,
                    "pool_end": parsed[1],
                    "raw_entries": parsed[0],
                }

    # Layout 2: Chunk-tagged container containing chunk tag 0x1C
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
                parsed = _read_cstr_pool_raw(data, pos + 12, cnt, pos + 8 + size)
                if parsed is not None and parsed[1] == pos + 8 + size:
                    found_chunk = {
                        "layout": "chunk_0x1c",
                        "chunk_offset": pos,
                        "pool_offset": pos + 12,
                        "pool_end": pos + 8 + size,
                        "raw_entries": parsed[0],
                    }
            pos += 8 + size
            chunks_seen += 1
        if chunk_ok and pos == total and found_chunk is not None:
            return found_chunk

    # Layout 3: VER\x00 + uint32 version + code_count + code_count*8 + str_count + pool
    if data[:4] == b"VER\x00" and total >= 16:
        code_cnt = struct.unpack_from("<I", data, 8)[0]
        pool_hdr = 12 + code_cnt * 8
        if pool_hdr + 4 <= total:
            str_cnt = struct.unpack_from("<I", data, pool_hdr)[0]
            parsed = _read_cstr_pool_raw(data, pool_hdr + 4, str_cnt, total)
            if parsed is not None:
                return {
                    "layout": "ver_code_pool",
                    "pool_offset": pool_hdr + 4,
                    "pool_end": parsed[1],
                    "raw_entries": parsed[0],
                }

    # Layout 4: Direct code_count + code_count*8 + str_count + pool
    code_cnt = struct.unpack_from("<I", data, 0)[0]
    pool_hdr = 4 + code_cnt * 8
    if pool_hdr + 4 <= total:
        str_cnt = struct.unpack_from("<I", data, pool_hdr)[0]
        parsed = _read_cstr_pool_raw(data, pool_hdr + 4, str_cnt, total)
        if parsed is not None:
            return {
                "layout": "direct_code_pool",
                "pool_offset": pool_hdr + 4,
                "pool_end": parsed[1],
                "raw_entries": parsed[0],
            }

    return None


def _rebuild_bin_file(data: bytes, updates: dict[int, tuple[str, str]], is_binu8: bool) -> bytes:
    located = _locate_bin_pool(data)
    if located is None:
        raise ValueError("Unable to locate NeXAS text pool in binary script")
    raw_entries: list[bytes] = list(located["raw_entries"])
    enc = _resolve_target_encoding("utf-8" if is_binu8 else "cp932", is_binu8=is_binu8)

    for idx, (source_text, target_text) in updates.items():
        if idx < 0 or idx >= len(raw_entries):
            raise IndexError(f"String pool index {idx} out of range (pool size {len(raw_entries)})")
        if target_text == source_text:
            # Identity writeback: keep original bytes bit-for-bit
            continue
        unescaped = target_text.replace("\\n", "\n")
        encoded = _encode_str(unescaped, enc)
        if b"\x00" in encoded:
            raise ValueError(f"Encoded text for slot {idx} contains embedded NUL byte")
        raw_entries[idx] = encoded

    new_pool = b"".join(entry + b"\x00" for entry in raw_entries)
    prefix = bytearray(data[: located["pool_offset"]])
    suffix = data[located["pool_end"] :]

    if located["layout"] == "header_0x1c":
        struct.pack_into("<I", prefix, 24, len(new_pool))
    elif located["layout"] == "chunk_0x1c":
        chunk_off = located["chunk_offset"]
        struct.pack_into("<I", prefix, chunk_off + 4, 4 + len(new_pool))

    return bytes(prefix) + new_pool + suffix


def _rebuild_lngt_file(raw: bytes, updates: dict[int, tuple[str, str]]) -> bytes:
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    if has_bom:
        orig_enc = "utf-8-bom"
        text = raw[3:].decode("utf-8")
    else:
        try:
            text = raw.decode("utf-8")
            orig_enc = "utf-8"
        except UnicodeDecodeError:
            text = raw.decode("cp932")
            orig_enc = "cp932"

    nl = "\r\n" if "\r\n" in text else "\n"
    # Count exact trailing newlines to preserve trailing blank lines verbatim
    trailing_nl_count = 0
    pos = len(text)
    nl_len = len(nl)
    while pos >= nl_len and text[pos - nl_len : pos] == nl:
        trailing_nl_count += 1
        pos -= nl_len

    core_text = text[:pos]
    lines = core_text.split(nl) if core_text or trailing_nl_count == 0 else []

    changed = False
    for line_no, (source_text, target_text) in updates.items():
        idx = line_no - 1
        if idx < 0 or idx >= len(lines):
            raise IndexError(f".lngt line {line_no} out of range (total lines {len(lines)})")
        if target_text == source_text:
            continue
        if "\n" in target_text or "\r" in target_text:
            raise ValueError(f".lngt line {line_no} replacement contains raw newline")
        lines[idx] = target_text
        changed = True

    if not changed:
        return raw

    rebuilt_text = nl.join(lines) + (nl * trailing_nl_count)
    target_enc = _resolve_target_encoding(orig_enc, is_binu8=False)
    if target_enc == "utf-8-bom":
        return b"\xef\xbb\xbf" + rebuilt_text.encode("utf-8")
    if target_enc == "utf-16le-bom":
        return b"\xff\xfe" + rebuilt_text.encode("utf-16le")
    return rebuilt_text.encode(target_enc)


def _parse_slot_index(row: dict, is_bin: bool) -> int:
    row_id = str(row.get("id") or "")
    if is_bin and "#S" in row_id:
        tail = row_id.rsplit("#S", 1)[1]
        if tail.isdigit():
            return int(tail)
    line_val = row.get("line")
    if isinstance(line_val, int) and line_val >= 1:
        return (line_val - 1) if is_bin else line_val
    raise ValueError(f"Row missing valid positive integer line/slot: {row_id!r}")


def apply_jsonl(results_jsonl: str, unpacked_dir: str) -> list[str]:
    base = os.path.realpath(unpacked_dir)
    if not os.path.isdir(base):
        raise FileNotFoundError(f"Unpacked directory does not exist: {unpacked_dir}")

    per_file_updates: dict[str, dict[int, tuple[str, str]]] = {}
    with open(results_jsonl, "r", encoding="utf-8-sig") as fh:
        for line_idx, raw_line in enumerate(fh, start=1):
            stripped = raw_line.strip()
            if not stripped:
                continue
            obj = json.loads(stripped)
            if not isinstance(obj, dict):
                raise ValueError(f"JSONL line {line_idx} must be a JSON object")
            rel = str(obj.get("file") or "").strip().replace("\\", "/")
            if not rel:
                raise ValueError(f"JSONL line {line_idx} missing 'file'")
            source = str(obj.get("source") or "")
            raw_target = obj.get("target")
            target = str(raw_target) if isinstance(raw_target, str) and raw_target != "" else source
            low = rel.lower()
            if not (low.endswith(BIN_SCRIPT_EXTS) or low.endswith(LNGT_EXTS)):
                continue
            slot = _parse_slot_index(obj, is_bin=low.endswith(BIN_SCRIPT_EXTS))
            per_file_updates.setdefault(rel, {})[slot] = (source, target)

    # Phase 1: pre-validate and serialize all updated files completely in memory
    staged: list[tuple[str, str, bytes]] = []
    for rel, updates in sorted(per_file_updates.items()):
        full = _stays_inside(base, rel)
        with open(full, "rb") as fh:
            orig_bytes = fh.read()
        low = rel.lower()
        if low.endswith(BIN_SCRIPT_EXTS):
            new_bytes = _rebuild_bin_file(orig_bytes, updates, is_binu8=low.endswith(".binu8"))
        else:
            new_bytes = _rebuild_lngt_file(orig_bytes, updates)
        staged.append((rel, full, new_bytes))

    # Phase 2: atomic replacement (no sidecar files written)
    written: list[str] = []
    for rel, full, new_bytes in staged:
        tmp_path = f"{full}.tmp.{os.getpid()}"
        try:
            with open(tmp_path, "wb") as out_fh:
                out_fh.write(new_bytes)
            os.replace(tmp_path, full)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise
        written.append(rel)
    return written


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("Usage: apply.py <results_jsonl> <unpacked_dir>\n")
        return 2
    apply_jsonl(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
