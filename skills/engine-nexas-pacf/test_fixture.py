#!/usr/bin/env python3
"""Zero-copyright synthetic roundtrip self-test for skills/engine-nexas-pacf.

Verifies in-process (no subprocess, passes Python AST security audit):
1. Synthetic NeXAS PACF archive (zstd + trailing XOR 0xFF MSB-first Huffman TOC)
   containing 0x1C-headered .binu8 scripts and a .lngt language table.
2. Full unpack -> extract -> identity apply -> repack -> re-unpack byte equality.
3. TOC jump-target filtering (both ASCII and Japanese scene stems matching TOC files).
4. Mutated variable-length writeback -> re-extract readback -> repack -> re-unpack
   roundtrip, preserving neighbor rows, jump targets in binary, and .lngt trailing blank line.
5. Zero auxiliary sidecar files (.papercup-*.json) written anywhere in target dirs.
"""

import json
import os
import struct
import sys
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import apply as nexas_apply
import extract as nexas_extract
import repack as nexas_repack
import unpack as nexas_unpack


def build_synthetic_binu8_header_0x1c(strings: list[str]) -> bytes:
    """Build a synthetic zero-copyright NeXAS .binu8 with 0x1C header + code + UTF-8 text pool."""
    # Emit one (opcode=0x04 PUSH_STR, param=idx) instruction per string
    code_bytes = b"".join(struct.pack("<II", 0x04, idx) for idx in range(len(strings)))
    pool_bytes = b"".join(s.encode("utf-8") + b"\x00" for s in strings)
    tail_bytes = struct.pack("<III", 0, 0, 0)  # empty int_vars, str_vars, funcs
    code_offset = 0x1C
    pool_offset = code_offset + len(code_bytes)
    header = struct.pack(
        "<7I",
        0x1C,
        1,
        code_offset,
        len(strings),
        pool_offset,
        len(strings),
        len(pool_bytes),
    )
    return header + code_bytes + pool_bytes + tail_bytes


def build_synthetic_binu8_chunk_0x1c(strings: list[str]) -> bytes:
    """Build a synthetic zero-copyright NeXAS .binu8 with chunk tag 0x1C text pool."""
    code_payload = struct.pack("<I", len(strings)) + b"".join(struct.pack("<II", 0x04, i) for i in range(len(strings)))
    pool_payload = struct.pack("<I", len(strings)) + b"".join(s.encode("utf-8") + b"\x00" for s in strings)
    return (
        struct.pack("<II", 0x01, len(code_payload))
        + code_payload
        + struct.pack("<II", 0x1C, len(pool_payload))
        + pool_payload
    )


def assert_no_sidecar_files(directory: str) -> None:
    for root, _dirs, files in os.walk(directory):
        for fname in files:
            if fname.startswith(".papercup-") and fname.endswith(".json"):
                raise AssertionError(f"Forbidden sidecar file written: {os.path.join(root, fname)}")


def snapshot_dir(directory: str) -> dict[str, bytes]:
    snap: dict[str, bytes] = {}
    base = os.path.realpath(directory)
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for fname in sorted(files):
            if fname.startswith(".") or fname.endswith(".bak"):
                continue
            full = os.path.join(root, fname)
            rel = os.path.relpath(full, base).replace("\\", "/")
            with open(full, "rb") as fh:
                snap[rel] = fh.read()
    return snap


def run_self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="papercup-nexas-fixture-") as tmp:
        src_dir = os.path.join(tmp, "source")
        os.makedirs(src_dir, exist_ok=True)

        # Synthetic scripts (zero copyrighted material)
        intro_strings = [
            "bg_station.png",
            "01_02_next",
            "01_03_始まり",
            "朝の光が窓から差し込んでいる。@n今日も一日が始まる。",
            "@r空@そら@の色が澄み渡っていた。",
            "UI::GetButton(\"StartButton\")",
        ]
        next_strings = [
            "駅前の時計は八時を指していた。",
            "01_03_始まり",
        ]
        chapter3_strings = [
            "風が少し冷たい。",
        ]
        lngt_content = "ゲームを始める\n続きから\n環境設定\n\n"

        with open(os.path.join(src_dir, "01_01_intro.binu8"), "wb") as fh:
            fh.write(build_synthetic_binu8_header_0x1c(intro_strings))
        with open(os.path.join(src_dir, "01_02_next.binu8"), "wb") as fh:
            fh.write(build_synthetic_binu8_chunk_0x1c(next_strings))
        with open(os.path.join(src_dir, "01_03_始まり.binu8"), "wb") as fh:
            fh.write(build_synthetic_binu8_header_0x1c(chapter3_strings))
        with open(os.path.join(src_dir, "system.lngt"), "wb") as fh:
            fh.write(lngt_content.encode("utf-8"))

        baseline_snap = snapshot_dir(src_dir)

        # 1) Pack into synthetic PACF archive (zstd + trailing XOR 0xFF MSB-first Huffman TOC)
        pac_path = os.path.join(tmp, "Script.pac")
        packed_count = nexas_repack.repack_archive(src_dir, pac_path)
        assert packed_count == 4, f"Expected 4 packed files, got {packed_count}"
        with open(pac_path, "rb") as fh:
            pac_bytes = fh.read()
        assert pac_bytes[:4] == b"PACF", f"Expected PACF header, got {pac_bytes[:4]!r}"

        # 2) Unpack and verify byte-exact match
        unpacked_dir = os.path.join(tmp, "unpacked")
        unpacked_files = nexas_unpack.unpack_archive(pac_path, unpacked_dir)
        assert len(unpacked_files) == 4, f"Expected 4 unpacked files, got {len(unpacked_files)}"
        assert snapshot_dir(unpacked_dir) == baseline_snap, "Unpacked files differ from baseline"
        assert_no_sidecar_files(unpacked_dir)

        # 3) Extract and verify schema + TOC jump-target filtering
        extracted_jsonl = os.path.join(tmp, "extracted.jsonl")
        rows = nexas_extract.extract_dir(unpacked_dir, extracted_jsonl)
        sources = [r["source"] for r in rows]

        assert "01_02_next" not in sources, "ASCII TOC jump target leaked into extracted rows"
        assert "01_03_始まり" not in sources, "Japanese TOC jump target leaked into extracted rows"
        assert "bg_station.png" not in sources, "Asset filename leaked into extracted rows"
        assert "UI::GetButton(\"StartButton\")" not in sources, "Widget lookup leaked into extracted rows"
        assert "朝の光が窓から差し込んでいる。@n今日も一日が始まる。" in sources
        assert "@r空@そら@の色が澄み渡っていた。" in sources
        assert "ゲームを始める" in sources
        assert "環境設定" in sources

        say_rows = [r for r in rows if r["kind"] == "say"]
        ui_rows = [r for r in rows if r["kind"] == "system"]
        assert len(say_rows) == 4, f"Expected 4 say rows, got {len(say_rows)}: {say_rows}"
        assert len(ui_rows) == 3, f"Expected 3 ui rows, got {len(ui_rows)}: {ui_rows}"
        for r in rows:
            assert isinstance(r["line"], int) and r["line"] >= 1
            assert "\n" not in r["source"] and "\r" not in r["source"]

        # 4) Identity writeback + repack + re-unpack -> byte-identical
        id_jsonl = os.path.join(tmp, "identity.jsonl")
        with open(id_jsonl, "w", encoding="utf-8", newline="\n") as fh:
            for r in rows:
                fh.write(json.dumps({**r, "target": r["source"]}, ensure_ascii=False) + "\n")
        nexas_apply.apply_jsonl(id_jsonl, unpacked_dir)
        assert_no_sidecar_files(unpacked_dir)
        assert snapshot_dir(unpacked_dir) == baseline_snap, "Identity apply mutated file bytes"

        rebuilt_id = os.path.join(tmp, "rebuilt_id.pac")
        nexas_repack.repack_archive(unpacked_dir, rebuilt_id)
        reunpacked_id = os.path.join(tmp, "reunpacked_id")
        nexas_unpack.unpack_archive(rebuilt_id, reunpacked_id)
        assert snapshot_dir(reunpacked_id) == baseline_snap, "Identity repack/re-unpack mismatch"

        # 5) Variable-length mutation writeback -> repack -> re-unpack -> re-extract readback
        mut_bin_target = "清晨的阳光透过窗户洒了进来。@n今天崭新的一天又开始了（变长写回测试）。"
        mut_lngt_target = "开始游戏"
        mut_rows = []
        for r in rows:
            if r["source"] == "朝の光が窓から差し込んでいる。@n今日も一日が始まる。":
                mut_rows.append({**r, "target": mut_bin_target})
            elif r["source"] == "ゲームを始める":
                mut_rows.append({**r, "target": mut_lngt_target})
            else:
                mut_rows.append({**r, "target": r["source"]})

        mut_jsonl = os.path.join(tmp, "mutated.jsonl")
        with open(mut_jsonl, "w", encoding="utf-8", newline="\n") as fh:
            for r in mut_rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")

        nexas_apply.apply_jsonl(mut_jsonl, unpacked_dir)
        assert_no_sidecar_files(unpacked_dir)

        # Verify .lngt trailing blank line preserved verbatim
        with open(os.path.join(unpacked_dir, "system.lngt"), "rb") as fh:
            lngt_after = fh.read().decode("utf-8")
        assert lngt_after.endswith("\n\n"), f".lngt trailing blank line lost: {lngt_after!r}"
        assert lngt_after == "开始游戏\n続きから\n環境設定\n\n", f"Unexpected .lngt content: {lngt_after!r}"

        # Repack -> fresh re-unpack -> re-extract readback
        rebuilt_mut = os.path.join(tmp, "rebuilt_mut.pac")
        nexas_repack.repack_archive(unpacked_dir, rebuilt_mut)
        reunpacked_mut = os.path.join(tmp, "reunpacked_mut")
        nexas_unpack.unpack_archive(rebuilt_mut, reunpacked_mut)
        assert_no_sidecar_files(reunpacked_mut)

        re_extracted_jsonl = os.path.join(tmp, "re_extracted.jsonl")
        re_rows = nexas_extract.extract_dir(reunpacked_mut, re_extracted_jsonl)
        assert len(re_rows) == len(rows), f"Row count drifted after mutation: {len(rows)} -> {len(re_rows)}"

        by_id = {r["id"]: r["source"] for r in re_rows}
        orig_by_id = {r["id"]: r["source"] for r in rows}
        for r in mut_rows:
            rid = r["id"]
            assert by_id[rid] == r["target"], f"Readback mismatch for {rid}: expected {r['target']!r}, got {by_id[rid]!r}"
        # Verify untouched neighbor rows and binary jump target survived intact
        assert any(by_id[rid] == orig_by_id[rid] for rid in orig_by_id if rid == "01_01_intro.binu8#S4")
        with open(os.path.join(reunpacked_mut, "01_01_intro.binu8"), "rb") as fh:
            parsed_after = nexas_extract.parse_nexas_bin_script(fh.read(), is_utf8=True)
        assert parsed_after is not None
        pool_texts = [t for _s, _e, t in parsed_after["entries"]]
        assert "01_02_next" in pool_texts and "01_03_始まり" in pool_texts, "Jump targets in binary were corrupted"

    print("engine-nexas-pacf synthetic roundtrip self-test PASSED")


if __name__ == "__main__":
    run_self_test()
