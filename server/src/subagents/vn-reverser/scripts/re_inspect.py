#!/usr/bin/env python3
"""Deterministic static triage helper for Paper Cup `vn_re_inspect`.

Subcommands:
  archive <file>
  pe_overview <exe> [--rtti-filter <kw>] [--max-rtti 40]
  xrefs <exe> [--string <text>] [--api <api_name>] [--va <hex_va>] [--max-hits 40]
  disasm <exe> --va <hex_va> [--max-insns 90] [--neighbors]
"""
import argparse
import collections
import json
import math
import os
import re
import struct
import sys

try:
    import pefile
except Exception as ex:  # pragma: no cover
    pefile = None
    PEFILE_ERR = str(ex)
else:
    PEFILE_ERR = None

try:
    import capstone
except Exception as ex:  # pragma: no cover
    capstone = None
    CAPSTONE_ERR = str(ex)
else:
    CAPSTONE_ERR = None

IMAGE_SCN_MEM_EXECUTE = 0x20000000

MAGIC_SIGNATURES = [
    ("PNG", b"\x89PNG\r\n\x1a\n"),
    ("BMP", b"BM"),
    ("JPG", b"\xff\xd8\xff"),
    ("OGG", b"OggS"),
    ("ZLIB_BEST", b"\x78\xda"),
    ("ZLIB_DEF", b"\x78\x9c"),
    ("ZLIB_FAST", b"\x78\x5e"),
    ("ZLIB_NONE", b"\x78\x01"),
    ("ZIP", b"PK\x03\x04"),
    ("ZSTD", b"\x28\xb5\x2f\xfd"),
    ("LZMA_PROP", b"\x5d\x00\x00"),
    ("GZIP", b"\x1f\x8b\x08"),
]

KEY_WIN32_APIS = {
    "createfilea",
    "createfilew",
    "readfile",
    "setfilepointer",
    "setfilepointerex",
    "getfilesize",
    "getfilesizeex",
    "getfileattributesa",
    "getfileattributesw",
    "findfirstfilea",
    "findfirstfilew",
    "mapviewoffile",
    "createfilemappinga",
    "createfilemappingw",
    "multibytetowidechar",
    "widechartomultibyte",
    "textouta",
    "textoutw",
    "exttextoutw",
    "getglyphoutlinew",
    "createfonta",
    "createfontw",
    "createfontindirecta",
    "createfontindirectw",
    "enumfontfamiliesexa",
    "enumfontfamiliesexw",
    "getacp",
    "getsystemdefaultlcid",
    "isdbcsleadbyte",
    "isdbcsleadbyteex",
    "loadlibrarya",
    "loadlibraryw",
    "getprocaddress",
    "fopen",
    "wfopen",
    "_wfopen",
    "fopen_s",
    "_wfopen_s",
    "fread",
}


def shannon_entropy(buf: bytes) -> float:
    if not buf:
        return 0.0
    counts = collections.Counter(buf)
    total = len(buf)
    ent = 0.0
    for c in counts.values():
        p = c / total
        ent -= p * math.log2(p)
    return round(ent, 3)


def scan_magic_hits(buf: bytes, base_offset: int, max_per_sig: int = 4):
    hits = []
    for name, sig in MAGIC_SIGNATURES:
        start = 0
        count = 0
        while count < max_per_sig:
            idx = buf.find(sig, start)
            if idx < 0:
                break
            if name == "BMP":
                if idx + 6 > len(buf):
                    break
                bmp_size = struct.unpack_from("<I", buf, idx + 2)[0]
                if bmp_size < 54 or bmp_size > 128 * 1024 * 1024:
                    start = idx + 1
                    continue
            hits.append({"magic": name, "offset": base_offset + idx, "hex_offset": hex(base_offset + idx)})
            count += 1
            start = idx + len(sig)
    # RIFF WEBP / WAV
    start = 0
    riff_count = 0
    while riff_count < 6:
        idx = buf.find(b"RIFF", start)
        if idx < 0 or idx + 12 > len(buf):
            break
        fourcc = buf[idx + 8 : idx + 12]
        if fourcc in (b"WEBP", b"WAVE"):
            hits.append(
                {
                    "magic": fourcc.decode("ascii"),
                    "offset": base_offset + idx,
                    "hex_offset": hex(base_offset + idx),
                }
            )
            riff_count += 1
        start = idx + 4
    return sorted(hits, key=lambda h: h["offset"])[:24]


def cmd_archive(path: str):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        head_len = min(size, 256 * 1024)
        head_buf = f.read(head_len)
        tail_len = min(size, 64 * 1024)
        tail_offset = max(0, size - tail_len)
        f.seek(tail_offset)
        tail_buf = f.read(tail_len)

    head_chunks = []
    for off in range(0, min(len(head_buf), 64 * 1024), 4096):
        chunk = head_buf[off : off + 4096]
        head_chunks.append(
            {
                "offset": off,
                "size": len(chunk),
                "entropy": shannon_entropy(chunk),
                "zero_ratio": round(chunk.count(0) / len(chunk), 4),
            }
        )

    tail_chunks = []
    tail_slice = tail_buf[-min(len(tail_buf), 32 * 1024) :]
    tail_slice_base = size - len(tail_slice)
    for off in range(0, len(tail_slice), 4096):
        chunk = tail_slice[off : off + 4096]
        tail_chunks.append(
            {
                "offset": tail_slice_base + off,
                "size": len(chunk),
                "entropy": shannon_entropy(chunk),
                "zero_ratio": round(chunk.count(0) / len(chunk), 4),
            }
        )

    autocorr = {}
    sample = head_buf[: min(len(head_buf), 16384)]
    if len(sample) > 512:
        for lag in (16, 32, 64, 128, 256):
            if lag < len(sample):
                matches = sum(1 for i in range(len(sample) - lag) if sample[i] == sample[i + lag])
                autocorr[str(lag)] = round(matches / (len(sample) - lag), 4)

    magics = scan_magic_hits(head_buf, 0)
    if tail_offset > len(head_buf):
        magics.extend(scan_magic_hits(tail_buf, tail_offset))

    return {
        "ok": True,
        "action": "archive",
        "path": path.replace("\\", "/"),
        "size": size,
        "head_64_hex": head_buf[:64].hex(),
        "tail_64_hex": tail_buf[-64:].hex() if tail_buf else "",
        "head_chunks_4k": head_chunks,
        "tail_chunks_4k": tail_chunks,
        "autocorrelation": autocorr,
        "magic_hits": magics[:24],
    }


def load_pe(exe_path: str):
    if pefile is None:
        raise RuntimeError(f"pefile unavailable: {PEFILE_ERR}")
    return pefile.PE(exe_path, fast_load=False)


def collect_imports(pe):
    image_base = pe.OPTIONAL_HEADER.ImageBase
    is_64 = pe.FILE_HEADER.Machine == 0x8664
    all_imports = []
    key_imports = []
    for attr in ("DIRECTORY_ENTRY_IMPORT", "DIRECTORY_ENTRY_DELAY_IMPORT"):
        entries = getattr(pe, attr, None)
        if not entries:
            continue
        is_delay = attr == "DIRECTORY_ENTRY_DELAY_IMPORT"
        for entry in entries:
            dll_name = (entry.dll or b"").decode("ascii", "replace")
            for imp in entry.imports:
                if not imp.name:
                    continue
                name = imp.name.decode("ascii", "replace")
                iat_va = getattr(imp, "address", None)
                if not iat_va and getattr(imp, "thunk_rva", None):
                    iat_va = image_base + imp.thunk_rva
                rec = {
                    "dll": dll_name,
                    "name": name,
                    "iat_va": hex(iat_va) if iat_va else None,
                    "delay": is_delay,
                }
                all_imports.append(rec)
                if name.lower() in KEY_WIN32_APIS:
                    key_imports.append(rec)
    return is_64, image_base, all_imports, key_imports


def collect_rtti_classes(pe, rtti_filter: str = "", max_rtti: int = 40):
    classes = []
    seen = set()
    kw = rtti_filter.strip().lower()
    for sec in pe.sections:
        if sec.Characteristics & IMAGE_SCN_MEM_EXECUTE:
            continue
        raw = sec.get_data() or b""
        for m in re.finditer(rb"\.\?AV([A-Za-z0-9_@$:<>]+?)@@", raw):
            name = m.group(1).decode("ascii", "replace")
            if kw and kw not in name.lower():
                continue
            if name in seen:
                continue
            seen.add(name)
            classes.append(name)
            if len(classes) >= max_rtti:
                return classes
    return classes


def cmd_pe_overview(exe_path: str, rtti_filter: str = "", max_rtti: int = 40):
    pe = load_pe(exe_path)
    is_64, image_base, all_imports, key_imports = collect_imports(pe)
    sections = []
    packed_hints = []
    for sec in pe.sections:
        name = sec.Name.rstrip(b"\x00").decode("ascii", "replace")
        ent = round(sec.get_entropy(), 3)
        is_exec = bool(sec.Characteristics & IMAGE_SCN_MEM_EXECUTE)
        sections.append(
            {
                "name": name,
                "va": hex(image_base + sec.VirtualAddress),
                "rva": hex(sec.VirtualAddress),
                "vsize": sec.Misc_VirtualSize,
                "raw_offset": hex(sec.PointerToRawData),
                "raw_size": sec.SizeOfRawData,
                "exec": is_exec,
                "write": bool(sec.Characteristics & 0x80000000),
                "entropy": ent,
            }
        )
        if is_exec and ent > 7.2:
            packed_hints.append(f"Executable section {name} has high entropy ({ent})")

    if len(all_imports) < 12:
        packed_hints.append(f"Very few named imports ({len(all_imports)}); binary may be packed or resolve APIs dynamically")

    rtti = collect_rtti_classes(pe, rtti_filter=rtti_filter, max_rtti=max_rtti)
    return {
        "ok": True,
        "action": "pe_overview",
        "arch": "x64" if is_64 else "x86",
        "image_base": hex(image_base),
        "entry_point_va": hex(image_base + pe.OPTIONAL_HEADER.AddressOfEntryPoint),
        "import_count": len(all_imports),
        "packed_hints": packed_hints,
        "sections": sections,
        "key_win32_apis": key_imports,
        "rtti_classes": rtti,
    }


def make_capstone_md(is_64: bool):
    if capstone is None:
        raise RuntimeError(f"capstone unavailable: {CAPSTONE_ERR}")
    mode = capstone.CS_MODE_64 if is_64 else capstone.CS_MODE_32
    md = capstone.Cs(capstone.CS_ARCH_X86, mode)
    md.detail = True
    return md


def find_executable_section_for_rva(pe, rva: int):
    for sec in pe.sections:
        span = max(sec.Misc_VirtualSize, sec.SizeOfRawData)
        if sec.VirtualAddress <= rva < sec.VirtualAddress + span:
            return sec
    return None


def preview_string_at_va(pe, image_base: int, target_va: int):
    rva = target_va - image_base
    if rva <= 0 or rva >= pe.OPTIONAL_HEADER.SizeOfImage:
        return None
    sec = find_executable_section_for_rva(pe, rva)
    if sec is None or (sec.Characteristics & IMAGE_SCN_MEM_EXECUTE):
        return None
    try:
        data = pe.get_data(rva, 96)
    except Exception:
        return None
    if not data:
        return None
    # UTF-16LE heuristic: printable ASCII/Japanese with 0x00 high byte or valid UTF-16 chars
    if len(data) >= 4 and data[0] >= 0x20 and data[1] == 0x00 and data[2] >= 0x20:
        end = 0
        while end + 1 < len(data) and (data[end] != 0 or data[end + 1] != 0):
            end += 2
        if end >= 4:
            try:
                s = data[:end].decode("utf-16le", "strict")
                if all(ch.isprintable() or ch in "\r\n\t" for ch in s):
                    return f'L"{s[:48]}"'
            except Exception:
                pass
    # ASCII string
    nul = data.find(b"\x00")
    ascii_slice = data[:nul] if nul >= 0 else data
    if len(ascii_slice) >= 3 and all(0x20 <= b < 0x7F or b in (9, 10, 13) for b in ascii_slice):
        return f'"{ascii_slice[:48].decode("ascii")}"'
    return None


def build_iat_lookup(pe):
    _, _, all_imports, _ = collect_imports(pe)
    iat_map = {}
    for rec in all_imports:
        if rec["iat_va"]:
            iat_map[int(rec["iat_va"], 16)] = f"{rec['dll']}!{rec['name']}"
    return iat_map


def cmd_xrefs(exe_path: str, string_query: str = "", api_query: str = "", va_str: str = "", max_hits: int = 40):
    pe = load_pe(exe_path)
    is_64, image_base, all_imports, _ = collect_imports(pe)
    md = make_capstone_md(is_64)
    targets = []

    if va_str:
        va_val = int(va_str, 16) if va_str.lower().startswith("0x") else int(va_str)
        targets.append((va_val, f"va:{hex(va_val)}"))

    if api_query:
        q = api_query.strip().lower()
        for rec in all_imports:
            if q == rec["name"].lower() or q in rec["name"].lower():
                if rec["iat_va"]:
                    targets.append((int(rec["iat_va"], 16), f"iat:{rec['dll']}!{rec['name']}"))

    if string_query:
        patterns = []
        for enc_name, enc in (("utf-16le", "utf-16le"), ("utf-8", "utf-8"), ("cp932", "cp932")):
            try:
                b = string_query.encode(enc)
                if b:
                    patterns.append((enc_name, b))
            except Exception:
                pass
        seen_vas = set()
        for sec in pe.sections:
            if sec.Characteristics & IMAGE_SCN_MEM_EXECUTE:
                continue
            raw = sec.get_data() or b""
            for enc_name, pat in patterns:
                start = 0
                while len(seen_vas) < 12:
                    idx = raw.find(pat, start)
                    if idx < 0:
                        break
                    rva = sec.VirtualAddress + idx
                    tva = image_base + rva
                    if tva not in seen_vas:
                        seen_vas.add(tva)
                        targets.append((tva, f"str({enc_name}):{string_query[:32]}"))
                    start = idx + max(1, len(pat))

    if not targets:
        return {
            "ok": True,
            "action": "xrefs",
            "arch": "x64" if is_64 else "x86",
            "targets": [],
            "hits": [],
            "note": "No matching string/API/VA targets found in PE.",
        }

    hits = []
    seen_insn_vas = set()
    target_by_val = {va: label for va, label in targets}
    target_bytes = [(va, struct.pack("<Q" if is_64 else "<I", va), label) for va, label in targets]

    for sec in pe.sections:
        if not (sec.Characteristics & IMAGE_SCN_MEM_EXECUTE):
            continue
        code = sec.get_data() or b""
        sec_va = image_base + sec.VirtualAddress

        if not is_64:
            for tva, tbytes, label in target_bytes:
                start = 0
                while len(hits) < max_hits:
                    idx = code.find(tbytes, start)
                    if idx < 0:
                        break
                    win_start = max(0, idx - 8)
                    win_end = min(len(code), idx + 8)
                    matched = False
                    for probe_start in range(win_start, idx + 1):
                        insns = list(md.disasm(code[probe_start:win_end], sec_va + probe_start, count=4))
                        for insn in insns:
                            if insn.address <= sec_va + idx < insn.address + insn.size:
                                if (tva in [op.imm for op in insn.operands if op.type == capstone.x86.X86_OP_IMM]
                                    or any(
                                        op.type == capstone.x86.X86_OP_MEM and (op.mem.disp & 0xFFFFFFFF) == tva
                                        for op in insn.operands
                                    )):
                                    if insn.address not in seen_insn_vas:
                                        seen_insn_vas.add(insn.address)
                                        hits.append(
                                            {
                                                "va": hex(insn.address),
                                                "insn": f"{insn.mnemonic} {insn.op_str}".strip(),
                                                "target_va": hex(tva),
                                                "target": label,
                                            }
                                        )
                                        matched = True
                                        break
                        if matched:
                            break
                    start = idx + 1
                    if len(hits) >= max_hits:
                        break
        else:
            # x64 RIP-relative disp32 scan (opcode bytes preceding 4-byte disp32) & E8 call rel32
            for idx in range(0, max(0, len(code) - 4)):
                if len(hits) >= max_hits:
                    break
                disp = struct.unpack_from("<i", code, idx)[0]
                rip_next = sec_va + idx + 4
                cand_va = rip_next + disp
                if cand_va in target_by_val:
                    win_start = max(0, idx - 6)
                    for probe_start in range(win_start, idx + 1):
                        insns = list(md.disasm(code[probe_start : min(len(code), idx + 8)], sec_va + probe_start, count=2))
                        if insns and insns[0].address + insns[0].size == rip_next:
                            insn = insns[0]
                            if insn.address not in seen_insn_vas:
                                seen_insn_vas.add(insn.address)
                                hits.append(
                                    {
                                        "va": hex(insn.address),
                                        "insn": f"{insn.mnemonic} {insn.op_str}".strip(),
                                        "target_va": hex(cand_va),
                                        "target": target_by_val[cand_va],
                                    }
                                )
                            break

    # Also catch direct x86/x64 relative E8 calls to VA when target itself is a code VA
    for tva, _, label in target_bytes:
        if len(hits) >= max_hits:
            break
        for sec in pe.sections:
            if not (sec.Characteristics & IMAGE_SCN_MEM_EXECUTE):
                continue
            code = sec.get_data() or b""
            sec_va = image_base + sec.VirtualAddress
            start = 0
            while len(hits) < max_hits:
                idx = code.find(b"\xe8", start)
                if idx < 0 or idx + 5 > len(code):
                    break
                rel = struct.unpack_from("<i", code, idx + 1)[0]
                if sec_va + idx + 5 + rel == tva:
                    insns = list(md.disasm(code[idx : idx + 5], sec_va + idx, count=1))
                    if insns and insns[0].address not in seen_insn_vas:
                        seen_insn_vas.add(insns[0].address)
                        hits.append(
                            {
                                "va": hex(insns[0].address),
                                "insn": f"{insns[0].mnemonic} {insns[0].op_str}".strip(),
                                "target_va": hex(tva),
                                "target": label,
                            }
                        )
                start = idx + 1

    return {
        "ok": True,
        "action": "xrefs",
        "arch": "x64" if is_64 else "x86",
        "targets": [{"va": hex(v), "label": lbl} for v, lbl in targets[:12]],
        "hits": sorted(hits, key=lambda h: int(h["va"], 16))[:max_hits],
    }


def scan_neighbor_prologues(sec_data: bytes, sec_va: int, center_va: int, is_64: bool):
    center_off = center_va - sec_va
    lo = max(0, center_off - 0x600)
    hi = min(len(sec_data), center_off + 0x600)
    prologues = (
        [b"\x48\x89\x5c\x24", b"\x48\x83\xec", b"\x40\x53", b"\x55\x48\x8b\xec"]
        if is_64
        else [b"\x55\x8b\xec", b"\x55\x89\xe5", b"\x83\xec"]
    )
    found = set()
    for pat in prologues:
        start = lo
        while True:
            idx = sec_data.find(pat, start, hi)
            if idx < 0:
                break
            if idx == 0 or sec_data[idx - 1] in (0xCC, 0xC3, 0x90) or (idx > 2 and sec_data[idx - 3] == 0xC2):
                found.add(sec_va + idx)
            start = idx + 1
    ordered = sorted(found, key=lambda v: (abs(v - center_va), v))
    return [hex(v) for v in ordered[:12]]


def cmd_disasm(exe_path: str, va_str: str, max_insns: int = 90, neighbors: bool = False):
    pe = load_pe(exe_path)
    is_64 = pe.FILE_HEADER.Machine == 0x8664
    image_base = pe.OPTIONAL_HEADER.ImageBase
    va = int(va_str, 16) if va_str.lower().startswith("0x") else int(va_str)
    rva = va - image_base
    sec = find_executable_section_for_rva(pe, rva)
    if sec is None:
        return {"ok": False, "error": f"VA {hex(va)} is outside PE image sections (ImageBase={hex(image_base)})"}
    sec_name = sec.Name.rstrip(b"\x00").decode("ascii", "replace")
    if not (sec.Characteristics & IMAGE_SCN_MEM_EXECUTE):
        return {
            "ok": False,
            "error": f"VA {hex(va)} falls in non-executable section '{sec_name}'; refusing to disassemble data",
        }

    md = make_capstone_md(is_64)
    iat_map = build_iat_lookup(pe)
    max_insns = max(10, min(240, int(max_insns)))
    sec_data = sec.get_data() or b""
    sec_va = image_base + sec.VirtualAddress
    off = va - sec_va
    chunk = sec_data[off : off + max_insns * 15]
    lines = []
    for insn in md.disasm(chunk, va, count=max_insns):
        comment_parts = []
        for op in insn.operands:
            if op.type == capstone.x86.X86_OP_IMM:
                cand = op.imm
                if cand in iat_map:
                    comment_parts.append(iat_map[cand])
                else:
                    s_prev = preview_string_at_va(pe, image_base, cand)
                    if s_prev:
                        comment_parts.append(s_prev)
            elif op.type == capstone.x86.X86_OP_MEM:
                disp = op.mem.disp
                if is_64 and op.mem.base == capstone.x86.X86_REG_RIP:
                    cand = insn.address + insn.size + disp
                elif not is_64 and op.mem.base == 0:
                    cand = disp
                else:
                    cand = None
                if cand:
                    if cand in iat_map:
                        comment_parts.append(iat_map[cand])
                    else:
                        s_prev = preview_string_at_va(pe, image_base, cand)
                        if s_prev:
                            comment_parts.append(s_prev)
        rec = {
            "va": hex(insn.address),
            "bytes": insn.bytes.hex(),
            "insn": f"{insn.mnemonic} {insn.op_str}".strip(),
        }
        if comment_parts:
            rec["note"] = "; ".join(comment_parts[:2])
        lines.append(rec)

    res = {
        "ok": True,
        "action": "disasm",
        "arch": "x64" if is_64 else "x86",
        "section": sec_name,
        "start_va": hex(va),
        "instructions": lines,
    }
    if len(lines) == 0:
        res["raw_head_hex"] = chunk[:16].hex()
        res["note"] = (
            "No valid instruction decoded at start_va (likely mid-instruction or padding bytes); "
            "inspect raw_head_hex or retry at one of neighbor_prologues / an aligned VA."
        )
    if neighbors:
        res["neighbor_prologues"] = scan_neighbor_prologues(sec_data, sec_va, va, is_64)
    return res


def main():
    parser = argparse.ArgumentParser(description="Paper Cup deterministic RE inspector")
    sub = parser.add_subparsers(dest="action", required=True)

    p_arc = sub.add_parser("archive")
    p_arc.add_argument("path")

    p_pe = sub.add_parser("pe_overview")
    p_pe.add_argument("path")
    p_pe.add_argument("--rtti-filter", default="")
    p_pe.add_argument("--max-rtti", type=int, default=40)

    p_xref = sub.add_parser("xrefs")
    p_xref.add_argument("path")
    p_xref.add_argument("--string", default="")
    p_xref.add_argument("--api", default="")
    p_xref.add_argument("--va", default="")
    p_xref.add_argument("--max-hits", type=int, default=40)

    p_dis = sub.add_parser("disasm")
    p_dis.add_argument("path")
    p_dis.add_argument("--va", required=True)
    p_dis.add_argument("--max-insns", type=int, default=90)
    p_dis.add_argument("--neighbors", action="store_true")

    args = parser.parse_args()
    try:
        if args.action == "archive":
            out = cmd_archive(args.path)
        elif args.action == "pe_overview":
            out = cmd_pe_overview(args.path, rtti_filter=args.rtti_filter, max_rtti=args.max_rtti)
        elif args.action == "xrefs":
            out = cmd_xrefs(
                args.path,
                string_query=args.string,
                api_query=args.api,
                va_str=args.va,
                max_hits=args.max_hits,
            )
        elif args.action == "disasm":
            out = cmd_disasm(args.path, va_str=args.va, max_insns=args.max_insns, neighbors=args.neighbors)
        else:
            out = {"ok": False, "error": f"Unknown action: {args.action}"}
    except Exception as ex:
        out = {"ok": False, "action": args.action, "error": str(ex)}

    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok", False) else 1


if __name__ == "__main__":
    sys.exit(main())
