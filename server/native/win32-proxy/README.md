# Paper Cup Win32 Proxy DLLs

Lightweight, zero-CRT-dependency Win32 DLL proxies (`version.dll` and `winmm.dll`) for runtime codepage (`CP932` / `CP_ACP` -> `CP936` GBK) and GDI charset (`SHIFTJIS_CHARSET 0x80` -> `GB2312_CHARSET 0x86`) redirection on Windows visual novel executables.

## Supported Proxy DLLs

- `version.dll` (`proxy_version.c`, `version.def`): forwards all 17 `version.dll` exports to `%SystemRoot%\System32\version.dll`.
- `winmm.dll` (`proxy_winmm.c`, `winmm.def`): forwards common multimedia, timer, waveOut, MMIO, MCI, joystick, MIDI, and mixer exports to `%SystemRoot%\System32\winmm.dll`.

Both proxies share `proxy_core.h` / `proxy_core.c`, which resolves target Win32 APIs prior to installing safe PE32 (`0x014c`) / PE32+ (`0x8664`) IAT hooks across the main executable and non-system modules in the executable's directory. If `papercup_patch.ini` is absent, forwarding still initializes cleanly with zero hooks installed.

## Building

Requires Node.js and either MSVC (`cl.exe` via Visual Studio Build Tools / `vcvars32.bat` + `vcvars64.bat`) or architecture-matching MinGW-w64 GCC (`i686-w64-mingw32-gcc` for `x86`, `x86_64-w64-mingw32-gcc` / MSYS2 `ucrt64` for `x64`).

```powershell
# Build all available architectures into server/native/win32-proxy/bin/
node server/native/win32-proxy/build.mjs --arch=all

# Build a specific architecture and fail if its toolchain is missing
node server/native/win32-proxy/build.mjs --arch=x64 --strict
node server/native/win32-proxy/build.mjs --arch=x86 --strict

# Override output directory
node server/native/win32-proxy/build.mjs --arch=all --out-dir=path/to/bin
```

Outputs are written to `<outDir>/x86/{version.dll,winmm.dll}`, `<outDir>/x64/{version.dll,winmm.dll}`, and `<outDir>/manifest.json`.

## Configuration (`papercup_patch.ini`)

Place `papercup_patch.ini` in the same directory as the proxy DLL (or its parent directory) with a `[patch]` section:

| Key | Default | Description |
| --- | --- | --- |
| `codepage` | `936` | Target ANSI/DBCS codepage (`0` disables `KERNEL32`/`USER32` codepage hooks). |
| `charset` | `134` | Target GDI font charset (`134` = `GB2312_CHARSET`; `0` disables charset rewriting). |
| `font_name` | `""` | Optional font family name (`UTF-16` INI value) used when `force_font_name=1`. |
| `force_font_name` | `0` | Set to `1` to replace font face names in `CreateFont*` / `CreateFontIndirect*` / `EnumFontFamilies*`. |
| `enable_width_compat` | `1` | Set to `1` to enable `MultiByteToWideChar`, `WideCharToMultiByte`, `IsDBCSLeadByte*`, and `CharNextExA` remapping. |
| `log_file` | `""` | Optional log file path; appends `[papercup-proxy] loaded arch=<x86|x64> proxy=<name> codepage=<cp> charset=<cs> hooks=<count>` on attach. |
