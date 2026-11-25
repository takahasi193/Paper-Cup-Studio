#!/usr/bin/env python3
"""
Patch a bundled game font (.ttf/.otf/.ttc) with missing CJK/Chinese glyphs copied
from a fallback CJK font while preserving base font family name, unitsPerEm,
vertical metrics, fixed-pitch flags, and CJK advance width grid alignment.

Usage:
  patch_font.py <base_font> <fallback_font> <out_font> [--charset-file <path>] [--include-gb2312] [--remap-mode none|sjis_fullwidth_slots] [--remap-out <path>]
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import unicodedata
from typing import Dict, List, Optional, Set, Tuple

try:
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.recordingPen import DecomposingRecordingPen
    from fontTools.pens.t2CharStringPen import T2CharStringPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import TTCollection, TTFont
    from fontTools.ttLib.tables import ttProgram
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
    from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
except ImportError as exc:
    sys.stderr.write(
        json.dumps(
            {
                "ok": False,
                "error": f"fontTools is required to patch fonts ({exc}). Install it via: pip install fonttools",
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    sys.exit(3)


FULLWIDTH_CHINESE_PUNCT = "，。！？；：“”‘’（）【】《》—…·"
CODEPAGE_GB2312_BIT = 1 << 18
UNICODE_RANGE2_CJK_BIT = 1 << (59 - 32)  # Bit 59 overall -> bit 27 of ulUnicodeRange2


def extract_family_name(tt: TTFont) -> str:
    if "name" not in tt:
        return ""
    for name_id in (1, 16, 4):
        rec = tt["name"].getName(name_id, 3, 1, 0x0409) or tt["name"].getName(name_id, 3, 1) or tt["name"].getName(name_id, 1, 0)
        if rec is not None:
            try:
                text = rec.toUnicode().strip()
                if text:
                    return text
            except Exception:
                pass
    for rec in tt["name"].names:
        if rec.nameID in (1, 16, 4):
            try:
                text = rec.toUnicode().strip()
                if text:
                    return text
            except Exception:
                pass
    return ""


def open_fallback_font(fallback_path: str) -> Tuple[TTFont, Optional[TTCollection]]:
    if fallback_path.lower().endswith(".ttc"):
        ttc = TTCollection(fallback_path)
        best_font: Optional[TTFont] = None
        best_cjk_hits = -1
        for font in ttc.fonts:
            cmap = font.getBestCmap() or {}
            hits = sum(1 for cp in (0x4E2D, 0x6F22, 0x4F60, 0x8FD9, 0x8BF4, 0x8BDD) if cp in cmap)
            if hits > best_cjk_hits:
                best_cjk_hits = hits
                best_font = font
            if hits >= 4:
                return font, ttc
        if best_font is not None and best_cjk_hits > 0:
            return best_font, ttc
        if ttc.fonts:
            return ttc.fonts[0], ttc
        raise ValueError(f"Empty TTC collection: {fallback_path}")
    return TTFont(fallback_path), None


def collect_target_codepoints(charset_file: Optional[str], include_gb2312: bool) -> List[int]:
    seen: Set[int] = set()
    ordered: List[int] = []

    def add_cp(cp: int) -> None:
        if cp < 0x80 or cp in seen:
            return
        seen.add(cp)
        ordered.append(cp)

    if charset_file and os.path.isfile(charset_file):
        with open(charset_file, "r", encoding="utf-8") as fh:
            for ch in fh.read():
                add_cp(ord(ch))

    if include_gb2312:
        for b1 in range(0xB0, 0xF8):
            for b2 in range(0xA1, 0xFF):
                try:
                    ch = bytes([b1, b2]).decode("gb2312")
                except UnicodeDecodeError:
                    continue
                if len(ch) == 1:
                    add_cp(ord(ch))
        for ch in FULLWIDTH_CHINESE_PUNCT:
            add_cp(ord(ch))

    return ordered


def resolve_ref_cjk_advance(base: TTFont, base_cmap: Dict[int, str], base_upm: int) -> int:
    hmtx = base["hmtx"]
    for ref_cp in (0x4E2D, 0x6F22):  # '中', '漢'
        gname = base_cmap.get(ref_cp)
        if gname and gname in hmtx.metrics:
            adv = int(hmtx.metrics[gname][0])
            if adv > 0:
                return adv
    return int(base_upm)


def can_encode_cp932(ch: str) -> bool:
    if len(ch) != 1:
        return False
    try:
        encoded = ch.encode("cp932")
        return encoded.decode("cp932") == ch
    except (UnicodeEncodeError, UnicodeDecodeError):
        return False


def is_excluded_slot_char(ch: str) -> bool:
    cp = ord(ch)
    if cp < 0x80:
        return True
    if 0x3000 <= cp <= 0x30FF:  # CJK punctuation, Hiragana, Katakana
        return True
    if 0xFF00 <= cp <= 0xFFEF:  # Halfwidth and Fullwidth Forms
        return True
    if 0x2000 <= cp <= 0x206F:  # General Punctuation
        return True
    if ch in FULLWIDTH_CHINESE_PUNCT:
        return True
    cat = unicodedata.category(ch)
    if cat.startswith(("P", "S", "Z", "C")):
        return True
    return False


def build_sjis_fullwidth_slot_pool(target_set: Set[int]) -> List[int]:
    """
    Build a deterministic pool of valid 2-byte JIS X 0208 Level-2 CP932 Kanji slots
    ordered from the rarest tail (0xEAA4) downwards toward 0x989F.
    """
    slots: List[int] = []
    seen_slot_cps: Set[int] = set()
    lead_bytes = list(range(0xEA, 0xDF, -1)) + list(range(0x9F, 0x97, -1))
    for b1 in lead_bytes:
        b2_hi = 0xA4 if b1 == 0xEA else 0xFC
        b2_lo = 0x9F if b1 == 0x98 else 0x40
        for b2 in range(b2_hi, b2_lo - 1, -1):
            if b2 == 0x7F:
                continue
            raw = bytes([b1, b2])
            try:
                ch = raw.decode("cp932")
            except UnicodeDecodeError:
                continue
            if len(ch) != 1:
                continue
            cp = ord(ch)
            if cp > 0xFFFF or cp in target_set or cp in seen_slot_cps:
                continue
            if is_excluded_slot_char(ch):
                continue
            try:
                if ch.encode("cp932") != raw:
                    continue
            except UnicodeEncodeError:
                continue
            seen_slot_cps.add(cp)
            slots.append(cp)
    return slots


def ensure_unicode_cmap_tables(
    base: TTFont,
    added_map: Dict[int, str],
    slot_remap: Optional[Dict[int, str]] = None,
) -> None:
    combined_map: Dict[int, str] = dict(added_map)
    if slot_remap:
        combined_map.update(slot_remap)
    if not combined_map:
        return
    cmap_table = base["cmap"]
    need_non_bmp = any(cp > 0xFFFF for cp in combined_map)
    has_format12 = False
    updated_any = False

    for sub in cmap_table.tables:
        if sub.platformID not in (0, 3):
            continue
        if sub.format == 4:
            for cp, gname in combined_map.items():
                if cp <= 0xFFFF:
                    sub.cmap[cp] = gname
            updated_any = True
        elif sub.format == 12:
            for cp, gname in combined_map.items():
                sub.cmap[cp] = gname
            has_format12 = True
            updated_any = True

    if not updated_any:
        sub4 = CmapSubtable.newSubtable(4)
        sub4.platformID = 3
        sub4.platEncID = 1
        sub4.language = 0
        sub4.cmap = {cp: g for cp, g in combined_map.items() if cp <= 0xFFFF}
        cmap_table.tables.append(sub4)

    if need_non_bmp and not has_format12:
        merged = dict(base.getBestCmap() or {})
        merged.update(combined_map)
        sub12 = CmapSubtable.newSubtable(12)
        sub12.platformID = 3
        sub12.platEncID = 10
        sub12.language = 0
        sub12.cmap = merged
        cmap_table.tables.append(sub12)


def update_os2_flags(base: TTFont) -> None:
    if "OS/2" not in base:
        return
    os2 = base["OS/2"]
    if getattr(os2, "version", 0) < 1:
        os2.version = 1
        if not hasattr(os2, "ulCodePageRange1"):
            os2.ulCodePageRange1 = 0
        if not hasattr(os2, "ulCodePageRange2"):
            os2.ulCodePageRange2 = 0
    os2.ulCodePageRange1 = int(getattr(os2, "ulCodePageRange1", 0)) | CODEPAGE_GB2312_BIT
    os2.ulUnicodeRange2 = int(getattr(os2, "ulUnicodeRange2", 0)) | UNICODE_RANGE2_CJK_BIT


def unique_glyph_name(cp: int, existing: Set[str]) -> str:
    stem = f"uni{cp:04X}" if cp <= 0xFFFF else f"u{cp:X}"
    if stem not in existing:
        existing.add(stem)
        return stem
    idx = 1
    while True:
        cand = f"{stem}_pcup{idx}"
        if cand not in existing:
            existing.add(cand)
            return cand
        idx += 1


def draw_scaled_via_decomposing(
    fb_glyph_set,
    fb_gname: str,
    scale: float,
    target_pen,
) -> None:
    rec = DecomposingRecordingPen(fb_glyph_set)
    fb_glyph_set[fb_gname].draw(rec)
    tpen = TransformPen(target_pen, (scale, 0, 0, scale, 0, 0))
    rec.replay(tpen)


def patch_single_ttfont(
    base: TTFont,
    fb: TTFont,
    target_codepoints: List[int],
    remap_mode: str = "none",
) -> Tuple[int, int, str, Dict[str, str], int]:
    base_upm = int(base["head"].unitsPerEm)
    fb_upm = int(fb["head"].unitsPerEm)
    scale = float(base_upm) / float(fb_upm) if fb_upm > 0 else 1.0

    base_cmap = dict(base.getBestCmap() or {})
    fb_cmap = fb.getBestCmap() or {}

    base_has_glyf = "glyf" in base
    fb_has_glyf = "glyf" in fb
    base_has_cff = "CFF " in base

    if not base_has_glyf and not base_has_cff:
        raise ValueError("Unsupported base font outline format (expected glyf or CFF).")

    ref_advance = resolve_ref_cjk_advance(base, base_cmap, base_upm)
    fb_glyph_set = fb.getGlyphSet()
    glyph_order = list(base.getGlyphOrder())
    existing_names = set(glyph_order)
    hmtx = base["hmtx"]

    added_map: Dict[int, str] = {}
    still_missing_count = 0
    slot_pool: List[int] = (
        build_sjis_fullwidth_slot_pool(set(target_codepoints))
        if remap_mode == "sjis_fullwidth_slots"
        else []
    )
    slot_idx = 0
    slot_remap: Dict[int, str] = {}
    char_map: Dict[str, str] = {}
    overflow_count = 0

    base_glyf = base["glyf"] if base_has_glyf else None
    fb_glyf = fb["glyf"] if fb_has_glyf else None

    cff_charstrings = None
    cff_private = None
    cff_nominal_width = 0
    if base_has_cff:
        top_dict = base["CFF "].cff.topDictIndex[0]
        cff_charstrings = top_dict.CharStrings
        cff_private = getattr(top_dict, "Private", None)
        cff_nominal_width = int(getattr(cff_private, "nominalWidthX", 0) or 0) if cff_private else 0

    for cp in target_codepoints:
        ch = chr(cp)
        needs_remap = remap_mode == "sjis_fullwidth_slots" and not can_encode_cp932(ch)
        target_gname: Optional[str] = base_cmap.get(cp)

        if target_gname is None:
            fb_gname = fb_cmap.get(cp)
            if not fb_gname:
                still_missing_count += 1
                continue

            new_gname = unique_glyph_name(cp, existing_names)

            if base_has_glyf and base_glyf is not None:
                new_glyph: Optional[Glyph] = None
                if fb_has_glyf and fb_glyf is not None:
                    src_glyph = fb_glyf[fb_gname]
                    if not src_glyph.isComposite():
                        new_glyph = Glyph()
                        new_glyph.numberOfContours = src_glyph.numberOfContours
                        if src_glyph.numberOfContours > 0 and getattr(src_glyph, "coordinates", None) is not None:
                            if abs(scale - 1.0) < 1e-9:
                                new_glyph.coordinates = GlyphCoordinates(src_glyph.coordinates)
                            else:
                                new_glyph.coordinates = GlyphCoordinates(
                                    [(int(round(x * scale)), int(round(y * scale))) for x, y in src_glyph.coordinates]
                                )
                            new_glyph.flags = copy.copy(src_glyph.flags)
                            new_glyph.endPtsOfContours = list(src_glyph.endPtsOfContours)
                        # Drop fallback bytecode instructions because base font fpgm/prep/cvt differ.
                        new_glyph.program = ttProgram.Program()
                        new_glyph.recalcBounds(base_glyf)
                    else:
                        tt_pen = TTGlyphPen(None)
                        draw_scaled_via_decomposing(fb_glyph_set, fb_gname, scale, tt_pen)
                        new_glyph = tt_pen.glyph()
                        new_glyph.recalcBounds(base_glyf)
                else:
                    tt_pen = TTGlyphPen(None)
                    cu2qu = Cu2QuPen(tt_pen, max_err=1.0, reverse_direction=True)
                    draw_scaled_via_decomposing(fb_glyph_set, fb_gname, scale, cu2qu)
                    new_glyph = tt_pen.glyph()
                    new_glyph.recalcBounds(base_glyf)

                if new_glyph.numberOfContours > 0 and hasattr(new_glyph, "xMin") and hasattr(new_glyph, "xMax"):
                    glyph_w = new_glyph.xMax - new_glyph.xMin
                    desired_lsb = int(round((ref_advance - glyph_w) / 2.0))
                    dx = desired_lsb - new_glyph.xMin
                    if dx != 0 and getattr(new_glyph, "coordinates", None) is not None:
                        new_glyph.coordinates.translate((dx, 0))
                        new_glyph.recalcBounds(base_glyf)
                    lsb = int(new_glyph.xMin)
                else:
                    lsb = 0

                base_glyf[new_gname] = new_glyph
                hmtx[new_gname] = (ref_advance, lsb)
            else:
                # CFF base font path
                assert cff_charstrings is not None
                t2_pen = T2CharStringPen(ref_advance, None)
                draw_scaled_via_decomposing(fb_glyph_set, fb_gname, scale, t2_pen)
                cs = t2_pen.getCharString(private=cff_private)
                cs.width = ref_advance
                if hasattr(cs, "calcBounds"):
                    bounds = cs.calcBounds(None)
                    if bounds is not None:
                        x_min, _y_min, x_max, _y_max = bounds
                        glyph_w = x_max - x_min
                        desired_lsb = int(round((ref_advance - glyph_w) / 2.0))
                        dx = desired_lsb - x_min
                        if abs(dx) >= 1.0:
                            t2_shift_pen = T2CharStringPen(ref_advance, None)
                            rec = DecomposingRecordingPen(fb_glyph_set)
                            fb_glyph_set[fb_gname].draw(rec)
                            rec.replay(TransformPen(t2_shift_pen, (scale, 0, 0, scale, dx, 0)))
                            cs = t2_shift_pen.getCharString(private=cff_private)
                        lsb = desired_lsb
                    else:
                        lsb = 0
                else:
                    lsb = 0
                cff_charstrings[new_gname] = cs
                hmtx[new_gname] = (ref_advance, lsb)

            glyph_order.append(new_gname)
            added_map[cp] = new_gname
            target_gname = new_gname
        elif not needs_remap:
            continue

        if needs_remap and target_gname is not None:
            if slot_idx < len(slot_pool):
                slot_cp = slot_pool[slot_idx]
                slot_idx += 1
                slot_remap[slot_cp] = target_gname
                char_map[ch] = chr(slot_cp)
            else:
                overflow_count += 1

    base.setGlyphOrder(glyph_order)
    base["maxp"].numGlyphs = len(glyph_order)
    if base_has_cff:
        base["CFF "].cff.topDictIndex[0].charset = glyph_order
    ensure_unicode_cmap_tables(base, added_map, slot_remap)
    update_os2_flags(base)

    base_family = extract_family_name(base)
    return len(added_map), still_missing_count, base_family, char_map, overflow_count


def write_atomic_json(out_path: str, payload: dict) -> None:
    abs_path = os.path.abspath(out_path)
    out_dir = os.path.dirname(abs_path)
    os.makedirs(out_dir, exist_ok=True)
    tmp_path = os.path.join(out_dir, f".{os.path.basename(abs_path)}.{os.getpid()}.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp_path, abs_path)
    except Exception:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Patch bundled VN font with CJK fallback glyphs.")
    parser.add_argument("base_font", help="Path to base game font (.ttf/.otf/.ttc)")
    parser.add_argument("fallback_font", help="Path to fallback CJK font (.ttf/.otf/.ttc)")
    parser.add_argument("out_font", help="Output patched font path")
    parser.add_argument("--charset-file", default=None, help="Optional UTF-8 file containing required target characters")
    parser.add_argument("--include-gb2312", action="store_true", help="Include all GB2312 Level-1/2 Hanzi and standard Chinese punctuation")
    parser.add_argument(
        "--remap-mode",
        choices=["none", "sjis_fullwidth_slots"],
        default="none",
        help="Optional CP932 fullwidth slot remapping mode (default: none)",
    )
    parser.add_argument("--remap-out", default=None, help="Optional output path for char_remap.json")
    args = parser.parse_args()

    target_codepoints = collect_target_codepoints(args.charset_file, args.include_gb2312)
    fb_font, fb_ttc = open_fallback_font(args.fallback_font)
    out_dir = os.path.dirname(os.path.abspath(args.out_font))
    os.makedirs(out_dir, exist_ok=True)
    tmp_out = os.path.join(out_dir, f".{os.path.basename(args.out_font)}.{os.getpid()}.tmp")

    char_map: Dict[str, str] = {}
    overflow_count = 0
    try:
        is_base_ttc = args.base_font.lower().endswith(".ttc")
        if is_base_ttc:
            base_ttc = TTCollection(args.base_font)
            total_added = 0
            total_missing = 0
            base_family = ""
            try:
                for idx, face in enumerate(base_ttc.fonts):
                    added, missing, fam, face_map, face_overflow = patch_single_ttfont(
                        face, fb_font, target_codepoints, remap_mode=args.remap_mode
                    )
                    if idx == 0:
                        total_added = added
                        total_missing = missing
                        base_family = fam
                        char_map = face_map
                        overflow_count = face_overflow
                base_ttc.save(tmp_out)
            finally:
                base_ttc.close()
            os.replace(tmp_out, args.out_font)
            verify_ttc = TTCollection(args.out_font)
            try:
                if not verify_ttc.fonts or not (verify_ttc.fonts[0].getBestCmap() or {}):
                    raise ValueError("Verification failed: patched TTC has empty cmap.")
            finally:
                verify_ttc.close()
        else:
            base_font = TTFont(args.base_font)
            try:
                total_added, total_missing, base_family, char_map, overflow_count = patch_single_ttfont(
                    base_font, fb_font, target_codepoints, remap_mode=args.remap_mode
                )
                base_font.save(tmp_out)
            finally:
                base_font.close()
            os.replace(tmp_out, args.out_font)
            verify_font = TTFont(args.out_font)
            try:
                if not (verify_font.getBestCmap() or {}):
                    raise ValueError("Verification failed: patched font has empty cmap.")
            finally:
                verify_font.close()
    except Exception:
        if os.path.exists(tmp_out):
            try:
                os.remove(tmp_out)
            except OSError:
                pass
        raise
    finally:
        if fb_ttc is not None:
            fb_ttc.close()
        else:
            fb_font.close()

    remap_file_written: Optional[str] = None
    if args.remap_mode == "sjis_fullwidth_slots" and args.remap_out:
        write_atomic_json(
            args.remap_out,
            {
                "schema": 1,
                "mode": "sjis_fullwidth_slots",
                "base_family": base_family,
                "remapped_count": len(char_map),
                "overflow_count": overflow_count,
                "char_map": char_map,
            },
        )
        remap_file_written = os.path.abspath(args.remap_out)

    out_bytes = os.path.getsize(args.out_font)
    stdout_payload = {
        "ok": True,
        "added_glyphs": total_added,
        "still_missing_count": total_missing,
        "base_family": base_family,
        "out_bytes": out_bytes,
    }
    if args.remap_mode == "sjis_fullwidth_slots":
        stdout_payload.update(
            {
                "remap_mode": args.remap_mode,
                "remapped_count": len(char_map),
                "remap_overflow_count": overflow_count,
                "remap_file": remap_file_written,
            }
        )
    sys.stdout.write(json.dumps(stdout_payload, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
