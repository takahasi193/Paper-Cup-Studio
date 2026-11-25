#!/usr/bin/env python3
"""NeXAS PACF (.pac) archive unpacker.

Format specification:
- 12-byte header: magic (b"PACF" or b"PAC\\x00"), uint32 count, uint32 pack_type
  - pack_type 0: raw (uncompressed)
  - pack_type 3 / 4: zlib deflate
  - pack_type 7: zstd (standard for modern NeXAS PACF)
- Contiguous entry payloads starting at offset 12.
- Trailing compressed TOC:
  - Last 4 bytes: uint32 LE toc_packed_size
  - Preceding toc_packed_size bytes: XOR 0xFF obfuscated, MSB-first static Huffman bitstream
  - Decompressed TOC: count * 76 bytes
    - 64 bytes NUL-padded entry filename (UTF-8 or CP932)
    - uint32 LE offset
    - uint32 LE unpacked_size
    - uint32 LE packed_size
"""

import os
import struct
import sys
import zlib

try:
    import zstandard as zstd
except ImportError:
    zstd = None

MAGIC_VALID = (b"PACF", b"PAC\x00")
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
TOC_ENTRY_SIZE = 76
MAX_ENTRIES = 65536
MAX_TOC_BYTES = 16 * 1024 * 1024
MAX_ENTRY_BYTES = 256 * 1024 * 1024


class _MsbBitReader:
    __slots__ = ("data", "bit_pos", "total_bits")

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.bit_pos = 0
        self.total_bits = len(data) * 8

    def read_bit(self) -> int:
        if self.bit_pos >= self.total_bits:
            raise ValueError("Unexpected EOF in Huffman bitstream")
        byte = self.data[self.bit_pos >> 3]
        bit = (byte >> (7 - (self.bit_pos & 7))) & 1
        self.bit_pos += 1
        return bit

    def read_byte(self) -> int:
        val = 0
        for _ in range(8):
            val = (val << 1) | self.read_bit()
        return val


def _read_huffman_tree(reader: _MsbBitReader, depth: int = 0):
    if depth > 64:
        raise ValueError("Huffman tree depth limit exceeded")
    if reader.read_bit() == 1:
        left = _read_huffman_tree(reader, depth + 1)
        right = _read_huffman_tree(reader, depth + 1)
        return (left, right)
    return reader.read_byte()


def decompress_nexas_huffman(encoded: bytes, expected_size: int) -> bytes:
    """Decompress a NeXAS trailing TOC buffer (XOR 0xFF + MSB-first static Huffman)."""
    if expected_size == 0:
        return b""
    if expected_size < 0 or expected_size > MAX_TOC_BYTES:
        raise ValueError(f"Invalid TOC unpacked size: {expected_size}")
    unmasked = bytes(b ^ 0xFF for b in encoded)
    reader = _MsbBitReader(unmasked)
    root = _read_huffman_tree(reader)
    out = bytearray(expected_size)
    if isinstance(root, int):
        out[:] = bytes([root]) * expected_size
        return bytes(out)
    for i in range(expected_size):
        node = root
        while not isinstance(node, int):
            node = node[1] if reader.read_bit() else node[0]
        out[i] = node
    return bytes(out)


def decode_entry_name(raw_name: bytes) -> str:
    nul = raw_name.find(b"\x00")
    trimmed = raw_name[:nul] if nul >= 0 else raw_name
    if not trimmed:
        raise ValueError("Empty archive entry name in TOC")
    try:
        return trimmed.decode("utf-8")
    except UnicodeDecodeError:
        return trimmed.decode("cp932")


def stays_inside(dest_dir: str, rel_name: str) -> str:
    norm = rel_name.replace("\\", "/").strip()
    if not norm or "\x00" in norm or norm.startswith("/") or (len(norm) >= 2 and norm[1] == ":"):
        raise ValueError(f"Unsafe archive entry path: {rel_name!r}")
    parts = [p for p in norm.split("/") if p and p != "."]
    if not parts or any(p == ".." for p in parts):
        raise ValueError(f"Path traversal in archive entry: {rel_name!r}")
    base = os.path.realpath(dest_dir)
    target = os.path.realpath(os.path.join(base, *parts))
    if os.path.commonpath([base, target]) != base or target == base:
        raise ValueError(f"Archive entry escapes destination directory: {rel_name!r}")
    return target


def _decompress_payload(payload: bytes, pack_type: int, unpacked_size: int) -> bytes:
    if unpacked_size < 0 or unpacked_size > MAX_ENTRY_BYTES:
        raise ValueError(f"Entry unpacked size out of bounds: {unpacked_size}")
    if pack_type == 0:
        if len(payload) != unpacked_size:
            raise ValueError(f"Raw entry size mismatch: {len(payload)} != {unpacked_size}")
        return payload
    if pack_type in (3, 4):
        if len(payload) == unpacked_size and not payload.startswith((b"\x78\x9c", b"\x78\x01", b"\x78\xda")):
            return payload
        data = zlib.decompress(payload)
        if len(data) != unpacked_size:
            raise ValueError(f"Zlib unpacked size mismatch: {len(data)} != {unpacked_size}")
        return data
    if pack_type == 7:
        if len(payload) == unpacked_size and not payload.startswith(ZSTD_MAGIC):
            return payload
        if zstd is None:
            raise RuntimeError("zstandard library is required to unpack pack_type=7 (zstd) PACF archives")
        dctx = zstd.ZstdDecompressor()
        data = dctx.decompress(payload, max_output_size=max(unpacked_size, 1))
        if len(data) != unpacked_size:
            raise ValueError(f"Zstd unpacked size mismatch: {len(data)} != {unpacked_size}")
        return data
    raise ValueError(f"Unsupported NeXAS PAC pack_type: {pack_type}")


def read_toc(archive_bytes: bytes):
    if len(archive_bytes) < 16:
        raise ValueError("Archive too small to be a valid NeXAS PACF file")
    magic, count, pack_type = struct.unpack_from("<4sII", archive_bytes, 0)
    if magic not in MAGIC_VALID:
        raise ValueError(f"Unsupported PAC magic: {magic!r}")
    if count > MAX_ENTRIES:
        raise ValueError(f"Entry count exceeds safety limit: {count}")
    toc_packed_size = struct.unpack_from("<I", archive_bytes, len(archive_bytes) - 4)[0]
    toc_start = len(archive_bytes) - 4 - toc_packed_size
    if toc_start < 12:
        raise ValueError(f"Corrupt trailing TOC size: {toc_packed_size}")
    toc_raw = decompress_nexas_huffman(archive_bytes[toc_start : len(archive_bytes) - 4], count * TOC_ENTRY_SIZE)
    entries = []
    for idx in range(count):
        base = idx * TOC_ENTRY_SIZE
        name = decode_entry_name(toc_raw[base : base + 64])
        offset, unpacked_size, packed_size = struct.unpack_from("<III", toc_raw, base + 64)
        if offset < 12 or offset + packed_size > toc_start:
            raise ValueError(f"Entry {name!r} slice [{offset}:{offset + packed_size}] out of archive bounds")
        entries.append((name, offset, unpacked_size, packed_size))
    return magic, pack_type, entries


def unpack_archive(archive_path: str, dest_dir: str) -> list[str]:
    with open(archive_path, "rb") as fh:
        archive_bytes = fh.read()
    _magic, pack_type, entries = read_toc(archive_bytes)
    os.makedirs(dest_dir, exist_ok=True)
    written: list[str] = []
    for name, offset, unpacked_size, packed_size in entries:
        out_path = stays_inside(dest_dir, name)
        payload = archive_bytes[offset : offset + packed_size]
        raw_data = _decompress_payload(payload, pack_type, unpacked_size)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as out_fh:
            out_fh.write(raw_data)
        written.append(name.replace("\\", "/"))
    return written


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        sys.stderr.write("Usage: unpack.py <archive_path> <dest_dir>\n")
        return 2
    unpack_archive(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
