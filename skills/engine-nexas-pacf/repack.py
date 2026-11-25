#!/usr/bin/env python3
"""NeXAS PACF (.pac) archive repacker.

Rebuilds a valid NeXAS PACF archive with:
- 12-byte header: b"PACF", uint32 count, uint32 pack_type (7 = zstd, or 0 raw fallback)
- Contiguous zstd-compressed entry payloads starting at offset 12
- Trailing 76-byte-per-entry TOC compressed with MSB-first static Huffman + XOR 0xFF
- Final uint32 LE toc_packed_size

Automatically skips dotfiles (such as .skill-manifest.json) and *.bak files.
Writes zero auxiliary sidecar files into the source directory.
"""

import heapq
import os
import struct
import sys

try:
    import zstandard as zstd
except ImportError:
    zstd = None

MAGIC_PACF = b"PACF"
PACK_TYPE_RAW = 0
PACK_TYPE_ZSTD = 7
TOC_NAME_BYTES = 64
MAX_ENTRIES = 65536


class _MsbBitWriter:
    __slots__ = ("buf", "cur", "bits")

    def __init__(self) -> None:
        self.buf = bytearray()
        self.cur = 0
        self.bits = 0

    def write_bit(self, bit: int) -> None:
        self.cur = (self.cur << 1) | (bit & 1)
        self.bits += 1
        if self.bits == 8:
            self.buf.append(self.cur)
            self.cur = 0
            self.bits = 0

    def write_byte(self, val: int) -> None:
        for shift in range(7, -1, -1):
            self.write_bit((val >> shift) & 1)

    def finish(self) -> bytes:
        if self.bits > 0:
            self.buf.append(self.cur << (8 - self.bits))
            self.cur = 0
            self.bits = 0
        return bytes(self.buf)


def _build_huffman_tree(data: bytes):
    counts: dict[int, int] = {}
    for b in data:
        counts[b] = counts.get(b, 0) + 1
    if not counts:
        return 0
    if len(counts) == 1:
        sym = next(iter(counts))
        # Always emit a 2-leaf internal node so every standard decoder reads >=1 bit per symbol
        return (sym, sym ^ 1)
    heap: list[tuple[int, int, object]] = []
    seq = 0
    for sym, freq in sorted(counts.items()):
        heapq.heappush(heap, (freq, seq, sym))
        seq += 1
    while len(heap) > 1:
        f1, _s1, n1 = heapq.heappop(heap)
        f2, _s2, n2 = heapq.heappop(heap)
        heapq.heappush(heap, (f1 + f2, seq, (n1, n2)))
        seq += 1
    return heap[0][2]


def _serialize_tree_and_codes(node, writer: _MsbBitWriter, prefix: list[int], codes: dict[int, list[int]]) -> None:
    if isinstance(node, int):
        writer.write_bit(0)
        writer.write_byte(node)
        codes[node] = list(prefix)
        return
    writer.write_bit(1)
    prefix.append(0)
    _serialize_tree_and_codes(node[0], writer, prefix, codes)
    prefix[-1] = 1
    _serialize_tree_and_codes(node[1], writer, prefix, codes)
    prefix.pop()


def compress_nexas_huffman(raw_toc: bytes) -> bytes:
    """Compress raw TOC bytes using MSB-first static Huffman and mask with XOR 0xFF."""
    if not raw_toc:
        return b""
    tree = _build_huffman_tree(raw_toc)
    writer = _MsbBitWriter()
    codes: dict[int, list[int]] = {}
    _serialize_tree_and_codes(tree, writer, [], codes)
    for b in raw_toc:
        for bit in codes[b]:
            writer.write_bit(bit)
    packed = writer.finish()
    return bytes(b ^ 0xFF for b in packed)


def encode_entry_name(rel_name: str) -> bytes:
    norm = rel_name.replace("\\", "/")
    try:
        raw = norm.encode("cp932")
    except UnicodeEncodeError:
        raw = norm.encode("utf-8")
    if len(raw) >= TOC_NAME_BYTES:
        raw_utf8 = norm.encode("utf-8")
        if len(raw_utf8) < TOC_NAME_BYTES:
            raw = raw_utf8
        else:
            raise ValueError(f"Entry name exceeds 63-byte NeXAS TOC slot: {rel_name!r}")
    return raw + b"\x00" * (TOC_NAME_BYTES - len(raw))


def collect_source_files(source_dir: str) -> list[tuple[str, str]]:
    base = os.path.realpath(source_dir)
    found: list[tuple[str, str]] = []
    for root, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for fname in sorted(files):
            if fname.startswith(".") or fname.endswith(".bak"):
                continue
            full = os.path.join(root, fname)
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, base).replace("\\", "/")
            found.append((rel, full))
    found.sort(key=lambda item: item[0])
    if len(found) > MAX_ENTRIES:
        raise ValueError(f"File count exceeds NeXAS safety limit: {len(found)}")
    return found


def repack_archive(source_dir: str, dest_archive: str, pack_type: int | None = None) -> int:
    files = collect_source_files(source_dir)
    if not files:
        raise ValueError(f"No files found to repack in {source_dir}")

    if pack_type is None:
        pack_type = PACK_TYPE_ZSTD if zstd is not None else PACK_TYPE_RAW
    if pack_type == PACK_TYPE_ZSTD and zstd is None:
        raise RuntimeError("zstandard library is required for pack_type=7 (zstd) repacking")

    compressor = zstd.ZstdCompressor(level=3) if pack_type == PACK_TYPE_ZSTD else None

    out_chunks: list[bytes] = [struct.pack("<4sII", MAGIC_PACF, len(files), pack_type)]
    toc_parts: list[bytes] = []
    cursor = 12

    for rel, full in files:
        with open(full, "rb") as fh:
            raw_data = fh.read()
        if compressor is not None:
            packed_data = compressor.compress(raw_data)
        else:
            packed_data = raw_data
        out_chunks.append(packed_data)
        toc_parts.append(encode_entry_name(rel) + struct.pack("<III", cursor, len(raw_data), len(packed_data)))
        cursor += len(packed_data)

    raw_toc = b"".join(toc_parts)
    encoded_toc = compress_nexas_huffman(raw_toc)
    out_chunks.append(encoded_toc)
    out_chunks.append(struct.pack("<I", len(encoded_toc)))

    dest_parent = os.path.dirname(os.path.abspath(dest_archive))
    if dest_parent:
        os.makedirs(dest_parent, exist_ok=True)
    tmp_path = f"{dest_archive}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "wb") as out_fh:
            for chunk in out_chunks:
                out_fh.write(chunk)
        os.replace(tmp_path, dest_archive)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise
    return len(files)


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("Usage: repack.py <source_dir> <dest_archive>\n")
        return 2
    repack_archive(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
