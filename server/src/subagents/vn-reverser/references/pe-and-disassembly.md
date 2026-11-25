# PE Layout, Dynamic Tracing, Static Memory, and Consumer Disassembly

Use `vn_re_inspect` (`pe_overview`, `xrefs`, `disasm`), `vn_re_trace` (`io_trace`, `read_watch`), and `pefile`/`capstone` (read-only) to trace how the game executable locates, decrypts, decompresses, and addresses script text.

## 1. Combine Dynamic Tracing + Static Disassembly (`vn_re_trace` -> `vn_re_inspect`)

Following classic Galgame reverse-engineering practice:

1. **Trace from the File I/O Source First (`vn_re_trace`)**:
   - Every engine must read its own archives via Win32 file APIs (`CreateFileA/W`, `ReadFile`, `GetFileAttributesA/W`, `FindFirstFileW`).
   - Run `vn_re_trace(mode="io_trace")` first to check whether the engine probes loose override files before opening the archive, and to capture exact `ReadFile` offsets, lengths, and caller VAs inside the main `.exe`.
   - Run `vn_re_trace(mode="read_watch", targetFilter="<archive>")` to place a `DR0` hardware read/write watchpoint directly on the `ReadFile` destination buffer. The first instructions hitting `DR0` (and modifying buffer bytes) lead straight to the decryption/decompression routine VA and caller stack without guessing across megabytes of `.text`.
2. **Resolve Static Context with `vn_re_inspect`**:
   - Start with `pe_overview` to inspect sections, `ImageBase`, Win32 File/Text API IAT slots, and C++ RTTI class names (`.?AV...@@`).
   - Use `xrefs` with string literals, Win32 APIs, or caller VAs captured by `vn_re_trace`.
   - Use `disasm(..., neighbors=true)` to disassemble the target VA with automatic IAT/string annotations AND discover sibling functions within `+/-0x600`.
3. **Focus on Inputs/Outputs, Neighbor Locality & Two-Step Transcription**:
   - Compiler-emitted helper/member functions of the same subsystem (e.g. loader, XOR decoder, decompressor) are usually placed consecutively in `.text`.
   - When a function contains heavy MSVC C++ template boilerplate (`std::wstring`/`std::vector`), verify its input/output buffers and caller arguments first instead of getting stuck reversing every internal utility instruction.
   - **Two-Step Algorithm Transcription**: First translate disassembly loops **1:1 instruction-by-instruction into literal Python** (matching shifts, masks, sign extension, and loop bounds) and pass the byte oracle; only refactor into high-level code afterward.

## 2. PE VA / RVA / File-Offset Invariant

- **NEVER assume `file_offset + ImageBase == VA` or `RVA == file_offset`.** Section virtual alignment (`SectionAlignment`, typically `0x1000`) almost always differs from raw file alignment (`FileAlignment`, typically `0x200` or `0x400`).
- Always resolve addresses through `pefile` (`pe.get_offset_from_rva(rva)`, `pe.get_rva_from_offset(fo)`, `ImageBase = pe.OPTIONAL_HEADER.ImageBase`) or `vn_re_inspect`:
  - `VA = ImageBase + RVA`
  - Verify `RVA` falls inside an executable section (`IMAGE_SCN_MEM_EXECUTE`, usually `.text`) **before** disassembling. Disassembling `.rdata`/`.data` addresses produces plausible-looking garbage.
- On x86-32, immediate pointers (`push imm32`) and indirect IAT calls (`call dword ptr [imm32]`, opcode `FF 15`) encode **VAs** (`ImageBase + RVA`). On x86-64, inspect RIP-relative displacements (`[rip + disp32]`).

## 3. High-Signal Static Anchors (When Dynamic Tracing Is Unavailable)

1. **IAT & Delay-Load Imports**:
   - File I/O: `CreateFileA/W`, `ReadFile`, `GetFileSizeEx`, `SetFilePointer`, `MapViewOfFile`, `_wfopen`.
   - Encoding, Font & Locale Checks: `MultiByteToWideChar`, `WideCharToMultiByte`, `TextOutW`, `GetGlyphOutlineW`, `CreateFontA/W`, `CreateFontIndirectA/W`, `EnumFontFamiliesExA/W`, `GetACP`, `GetSystemDefaultLCID`, `IsDBCSLeadByte`, `IsDBCSLeadByteEx`.
2. **Exact `.rdata` String Xrefs**: archive names (`Scene.pck`, `.arc`, `Gameexe.dat`), assertion/error literals (`failed to decompress`, Japanese error strings) in UTF-16LE, UTF-8, or CP932.
3. **C++ RTTI (`.?AV...@@`) & VTables**: surfaces archive/scene manager class names and virtual call slots.
4. **Export / Resource Metadata**: check PE exports and resources before concluding UI text lives solely in scripts.

## 4. CP932 -> GBK Hardcoded Range Checks & Semi-Dynamic Hooks

- **Hardcoded Shift-JIS Byte-Range Checks**: If localized GBK text exhibits truncated glyphs or partial mojibake while UTF-16/CP932 decoding looks sound, inspect text-rendering and line-wrap functions for hardcoded Shift-JIS boundary checks — lead bytes `0x81–0x9F` / `0xE0–0xEF` and trail bytes `0x40–0xFC` excluding `0x7F` (GBK uses `0x81–0xFE` lead and `0x40–0xFE` trail).
- **File-Level Semi-Dynamic Replacement > Text-Level Hook**: If an archive is too complex to repack statically, prefer hooking the post-read/post-decrypt file buffer (replacing the entire decrypted script buffer in memory) over hooking individual text-display calls, which otherwise desync backlog/history and save states.
- **Cross-CRT Allocator Safety**: When a Hook DLL enlarges a buffer that the game executable will later `free`/`delete`, never allocate the replacement with the Hook DLL's own CRT `malloc`/`new` (different MSVC CRT heaps crash on free); reuse the game binary's own allocator slot or a matching Win32 heap (`HeapAlloc` / `VirtualAlloc`).

## 5. Static Memory vs Original File Bytes

- **Loader Fixups & Uninitialized Spans**: when a section has `Misc_VirtualSize > SizeOfRawData` (`.bss`), or a `.data` slot reads `0x00000000`, it is populated at runtime by constructors or key-derivation routines — never zero-fill unread spans or assume absent keys without tracing xrefs to the writer (or observing live memory via `vn_re_trace`).
- **Read Bounds Check**: verify slice lengths against `SizeOfRawData`; truncated reads mean missing coverage, not trailing zeros.
- **Packed / Protected Binaries**: high `.text` entropy (`> 7.2`) + minimal imports indicate packing; do not confuse unpacker stub instructions with script parsing logic.
- **Non-Contiguous Functions & Indirect Calls**: compiler optimizations split cold blocks and dispatch via vtables/function pointers; confirm whether a slot holds a `.text` VA vs an uninitialized `.data` slot before claiming it is runtime-only.

## 6. Consumer-Side Addressing Proof (Mandatory Before `apply.py`)

Before assuming translated strings can change byte length:

1. Locate the script VM / loader routine that reads a string slot from an unpacked script or string pool.
2. Prove from disassembled instructions whether the consumer indexes strings by:
   - **Record index** (`strings[idx]` via an `(offset, length)` table — safe for variable-length strings once the offset/length table and downstream section offsets are recalculated), or
   - **Direct byte/code-unit offset or embedded pointer** (requires relocating every bytecode/table reference atomically, or preserving slot layout).
3. Record exact `VA` / `file offset` evidence of the addressing instructions in `.papercup/research/<engine>/01-layout.md`.
