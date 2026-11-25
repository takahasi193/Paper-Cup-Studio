#!/usr/bin/env python3
"""Controlled lightweight Win32 API & DR0 hardware-breakpoint tracer (`vn_re_trace`).

Runs ONLY on Windows against an isolated sandbox copy inside a Job Object with
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and strict wall-clock timeout.
Supports both 32-bit WOW64 targets (from 64-bit Python) and native 64-bit targets.
"""
import argparse
import ctypes
import json
import os
import struct
import sys
import time

OS_NOISE_EXTS = (".dll", ".mui", ".nls", ".ttf", ".ttc", ".otf", ".fon", ".cat", ".manifest")
OS_NOISE_DIR_MARKERS = ("\\windows\\", "/windows/", "\\programdata\\", "/programdata/")


def is_os_noise_path(path_str: str) -> bool:
    """Return True for Windows system/font/DLL noise paths that should not crowd target io_trace."""
    low = (path_str or "").strip().lower()
    if not low:
        return True
    if low.endswith(OS_NOISE_EXTS):
        return True
    return any(marker in low for marker in OS_NOISE_DIR_MARKERS)


def read_pe_preferred_image_base(exe_path: str):
    """Read PE OptionalHeader preferred ImageBase from disk for ASLR static VA normalization."""
    try:
        with open(exe_path, "rb") as fh:
            hdr = fh.read(0x1000)
        if len(hdr) < 0x100 or hdr[:2] != b"MZ":
            return None
        e_lfanew = struct.unpack_from("<I", hdr, 0x3C)[0]
        if e_lfanew + 0x58 > len(hdr) or hdr[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
            return None
        opt_off = e_lfanew + 24
        magic = struct.unpack_from("<H", hdr, opt_off)[0]
        if magic == 0x20B:
            return struct.unpack_from("<Q", hdr, opt_off + 24)[0]
        if magic == 0x10B:
            return struct.unpack_from("<I", hdr, opt_off + 28)[0]
        return None
    except Exception:
        return None


def is_call_preceding_bytes(tail7: bytes, is_64: bool = False) -> bool:
    """Check whether the 7 bytes immediately preceding a stack DWORD end with an x86/x64 CALL."""
    if not tail7 or len(tail7) != 7:
        return False
    # Direct relative CALL rel32 (E8 xx xx xx xx)
    if tail7[2] == 0xE8:
        return True

    def _ff_len2(op: int, modrm: int) -> bool:
        if op != 0xFF or (modrm & 0x38) != 0x10:
            return False
        mod = modrm >> 6
        rm = modrm & 7
        return mod == 3 or (mod == 0 and rm not in (4, 5))

    def _ff_len3(b0: int, b1: int, b2: int) -> bool:
        if b0 != 0xFF or (b1 & 0x38) != 0x10:
            return False
        mod = b1 >> 6
        rm = b1 & 7
        if mod == 0 and rm == 4:
            return (b2 & 7) != 5
        return mod == 1 and rm != 4

    def _ff_len6(op: int, modrm: int) -> bool:
        if op != 0xFF or (modrm & 0x38) != 0x10:
            return False
        mod = modrm >> 6
        rm = modrm & 7
        return modrm == 0x15 or (mod == 2 and rm != 4)

    # 2-byte: FF D0..D7 / FF 10..17 (excl rm=4,5)
    if _ff_len2(tail7[5], tail7[6]):
        return True
    # 3-byte: [REX] + len2 (x64), or FF modrm sib/disp8
    if is_64 and 0x40 <= tail7[4] <= 0x4F and _ff_len2(tail7[5], tail7[6]):
        return True
    if _ff_len3(tail7[4], tail7[5], tail7[6]):
        return True
    # 4-byte: [REX] + len3 (x64), or FF 54 sib disp8
    if is_64 and 0x40 <= tail7[3] <= 0x4F and _ff_len3(tail7[4], tail7[5], tail7[6]):
        return True
    if tail7[3] == 0xFF and tail7[4] == 0x54:
        return True
    # 5-byte: [REX] + FF 54 sib disp8 (x64)
    if is_64 and 0x40 <= tail7[2] <= 0x4F and tail7[3] == 0xFF and tail7[4] == 0x54:
        return True
    # 6-byte: FF 15 disp32 / FF 90..97 disp32
    if _ff_len6(tail7[1], tail7[2]):
        return True
    # 7-byte: [REX] + len6 (x64), FF 94 sib disp32, or FF 14 [base=5] disp32
    if is_64 and 0x40 <= tail7[0] <= 0x4F and _ff_len6(tail7[1], tail7[2]):
        return True
    if tail7[0] == 0xFF and (tail7[1] == 0x94 or (tail7[1] == 0x14 and (tail7[2] & 7) == 5)):
        return True
    return False


if os.name != "nt":
    def main():
        print(json.dumps({"ok": True, "supported": False, "reason": "vn_re_trace requires Windows"}))
        return 0
    if __name__ == "__main__":
        sys.exit(main())
    # Allow cross-platform unit imports to return early before ctypes.WinDLL
    WintypesDummy = None
else:
    from ctypes import wintypes


# Win32 constants
DEBUG_ONLY_THIS_PROCESS = 0x00000002
CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000

INFINITE = 0xFFFFFFFF
DBG_CONTINUE = 0x00010002
DBG_EXCEPTION_NOT_HANDLED = 0x80010001

EXCEPTION_DEBUG_EVENT = 1
CREATE_THREAD_DEBUG_EVENT = 2
CREATE_PROCESS_DEBUG_EVENT = 3
EXIT_THREAD_DEBUG_EVENT = 4
EXIT_PROCESS_DEBUG_EVENT = 5
LOAD_DLL_DEBUG_EVENT = 6
UNLOAD_DLL_DEBUG_EVENT = 7

EXCEPTION_BREAKPOINT = 0x80000003
STATUS_WX86_BREAKPOINT = 0x4000001F
EXCEPTION_SINGLE_STEP = 0x80000004
STATUS_WX86_SINGLE_STEP = 0x4000001E

THREAD_ALL_ACCESS = 0x001FFFFF
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JobObjectExtendedLimitInformation = 9

WOW64_CONTEXT_i386 = 0x00010000
WOW64_CONTEXT_CONTROL = WOW64_CONTEXT_i386 | 0x01
WOW64_CONTEXT_INTEGER = WOW64_CONTEXT_i386 | 0x02
WOW64_CONTEXT_SEGMENTS = WOW64_CONTEXT_i386 | 0x04
WOW64_CONTEXT_FLOATING_POINT = WOW64_CONTEXT_i386 | 0x08
WOW64_CONTEXT_DEBUG_REGISTERS = WOW64_CONTEXT_i386 | 0x10
WOW64_CONTEXT_ALL = (
    WOW64_CONTEXT_CONTROL
    | WOW64_CONTEXT_INTEGER
    | WOW64_CONTEXT_SEGMENTS
    | WOW64_CONTEXT_FLOATING_POINT
    | WOW64_CONTEXT_DEBUG_REGISTERS
)

AMD64_CONTEXT = 0x00100000
AMD64_CONTEXT_CONTROL = AMD64_CONTEXT | 0x01
AMD64_CONTEXT_INTEGER = AMD64_CONTEXT | 0x02
AMD64_CONTEXT_SEGMENTS = AMD64_CONTEXT | 0x04
AMD64_CONTEXT_FLOATING_POINT = AMD64_CONTEXT | 0x08
AMD64_CONTEXT_DEBUG_REGISTERS = AMD64_CONTEXT | 0x10
AMD64_CONTEXT_FULL = AMD64_CONTEXT_CONTROL | AMD64_CONTEXT_INTEGER | AMD64_CONTEXT_FLOATING_POINT
AMD64_CONTEXT_ALL = AMD64_CONTEXT_FULL | AMD64_CONTEXT_SEGMENTS | AMD64_CONTEXT_DEBUG_REGISTERS

MAX_PATH_CHARS = 520


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount",
        "WriteOperationCount",
        "OtherOperationCount",
        "ReadTransferCount",
        "WriteTransferCount",
        "OtherTransferCount",
    )]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class EXCEPTION_RECORD(ctypes.Structure):
    pass


EXCEPTION_RECORD._fields_ = [
    ("ExceptionCode", wintypes.DWORD),
    ("ExceptionFlags", wintypes.DWORD),
    ("ExceptionRecord", ctypes.POINTER(EXCEPTION_RECORD)),
    ("ExceptionAddress", ctypes.c_void_p),
    ("NumberParameters", wintypes.DWORD),
    ("ExceptionInformation", ctypes.c_size_t * 15),
]


class EXCEPTION_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("ExceptionRecord", EXCEPTION_RECORD), ("dwFirstChance", wintypes.DWORD)]


class CREATE_THREAD_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hThread", wintypes.HANDLE),
        ("lpThreadLocalBase", ctypes.c_void_p),
        ("lpStartAddress", ctypes.c_void_p),
    ]


class CREATE_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hFile", wintypes.HANDLE),
        ("hProcess", wintypes.HANDLE),
        ("hThread", wintypes.HANDLE),
        ("lpBaseOfImage", ctypes.c_void_p),
        ("dwDebugInfoFileOffset", wintypes.DWORD),
        ("nDebugInfoSize", wintypes.DWORD),
        ("lpThreadLocalBase", ctypes.c_void_p),
        ("lpStartAddress", ctypes.c_void_p),
        ("lpImageName", ctypes.c_void_p),
        ("fUnicode", wintypes.WORD),
    ]


class EXIT_THREAD_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("dwExitCode", wintypes.DWORD)]


class EXIT_PROCESS_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("dwExitCode", wintypes.DWORD)]


class LOAD_DLL_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("hFile", wintypes.HANDLE),
        ("lpBaseOfDll", ctypes.c_void_p),
        ("dwDebugInfoFileOffset", wintypes.DWORD),
        ("nDebugInfoSize", wintypes.DWORD),
        ("lpImageName", ctypes.c_void_p),
        ("fUnicode", wintypes.WORD),
    ]


class UNLOAD_DLL_DEBUG_INFO(ctypes.Structure):
    _fields_ = [("lpBaseOfDll", ctypes.c_void_p)]


class DEBUG_EVENT_UNION(ctypes.Union):
    _fields_ = [
        ("Exception", EXCEPTION_DEBUG_INFO),
        ("CreateThread", CREATE_THREAD_DEBUG_INFO),
        ("CreateProcessInfo", CREATE_PROCESS_DEBUG_INFO),
        ("ExitThread", EXIT_THREAD_DEBUG_INFO),
        ("ExitProcess", EXIT_PROCESS_DEBUG_INFO),
        ("LoadDll", LOAD_DLL_DEBUG_INFO),
        ("UnloadDll", UNLOAD_DLL_DEBUG_INFO),
        ("Pad", ctypes.c_ubyte * 160),
    ]


class DEBUG_EVENT(ctypes.Structure):
    _fields_ = [
        ("dwDebugEventCode", wintypes.DWORD),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
        ("u", DEBUG_EVENT_UNION),
    ]


class WOW64_FLOATING_SAVE_AREA(ctypes.Structure):
    _fields_ = [
        ("ControlWord", wintypes.DWORD),
        ("StatusWord", wintypes.DWORD),
        ("TagWord", wintypes.DWORD),
        ("ErrorOffset", wintypes.DWORD),
        ("ErrorSelector", wintypes.DWORD),
        ("DataOffset", wintypes.DWORD),
        ("DataSelector", wintypes.DWORD),
        ("RegisterArea", ctypes.c_ubyte * 80),
        ("Cr0NpxState", wintypes.DWORD),
    ]


class WOW64_CONTEXT(ctypes.Structure):
    _fields_ = [
        ("ContextFlags", wintypes.DWORD),
        ("Dr0", wintypes.DWORD),
        ("Dr1", wintypes.DWORD),
        ("Dr2", wintypes.DWORD),
        ("Dr3", wintypes.DWORD),
        ("Dr6", wintypes.DWORD),
        ("Dr7", wintypes.DWORD),
        ("FloatSave", WOW64_FLOATING_SAVE_AREA),
        ("SegGs", wintypes.DWORD),
        ("SegFs", wintypes.DWORD),
        ("SegEs", wintypes.DWORD),
        ("SegDs", wintypes.DWORD),
        ("Edi", wintypes.DWORD),
        ("Esi", wintypes.DWORD),
        ("Ebx", wintypes.DWORD),
        ("Edx", wintypes.DWORD),
        ("Ecx", wintypes.DWORD),
        ("Eax", wintypes.DWORD),
        ("Ebp", wintypes.DWORD),
        ("Eip", wintypes.DWORD),
        ("SegCs", wintypes.DWORD),
        ("EFlags", wintypes.DWORD),
        ("Esp", wintypes.DWORD),
        ("SegSs", wintypes.DWORD),
        ("ExtendedRegisters", ctypes.c_ubyte * 512),
    ]


assert ctypes.sizeof(WOW64_CONTEXT) == 716


class M128A(ctypes.Structure):
    _fields_ = [("Low", ctypes.c_uint64), ("High", ctypes.c_int64)]


class CONTEXT64(ctypes.Structure):
    _fields_ = [
        ("P1Home", ctypes.c_uint64),
        ("P2Home", ctypes.c_uint64),
        ("P3Home", ctypes.c_uint64),
        ("P4Home", ctypes.c_uint64),
        ("P5Home", ctypes.c_uint64),
        ("P6Home", ctypes.c_uint64),
        ("ContextFlags", wintypes.DWORD),
        ("MxCsr", wintypes.DWORD),
        ("SegCs", wintypes.WORD),
        ("SegDs", wintypes.WORD),
        ("SegEs", wintypes.WORD),
        ("SegFs", wintypes.WORD),
        ("SegGs", wintypes.WORD),
        ("SegSs", wintypes.WORD),
        ("EFlags", wintypes.DWORD),
        ("Dr0", ctypes.c_uint64),
        ("Dr1", ctypes.c_uint64),
        ("Dr2", ctypes.c_uint64),
        ("Dr3", ctypes.c_uint64),
        ("Dr6", ctypes.c_uint64),
        ("Dr7", ctypes.c_uint64),
        ("Rax", ctypes.c_uint64),
        ("Rcx", ctypes.c_uint64),
        ("Rdx", ctypes.c_uint64),
        ("Rbx", ctypes.c_uint64),
        ("Rsp", ctypes.c_uint64),
        ("Rbp", ctypes.c_uint64),
        ("Rsi", ctypes.c_uint64),
        ("Rdi", ctypes.c_uint64),
        ("R8", ctypes.c_uint64),
        ("R9", ctypes.c_uint64),
        ("R10", ctypes.c_uint64),
        ("R11", ctypes.c_uint64),
        ("R12", ctypes.c_uint64),
        ("R13", ctypes.c_uint64),
        ("R14", ctypes.c_uint64),
        ("R15", ctypes.c_uint64),
        ("Rip", ctypes.c_uint64),
        ("FltSave", ctypes.c_ubyte * 512),
        ("VectorRegister", M128A * 26),
        ("VectorControl", ctypes.c_uint64),
        ("DebugControl", ctypes.c_uint64),
        ("LastBranchToRip", ctypes.c_uint64),
        ("LastBranchFromRip", ctypes.c_uint64),
        ("LastExceptionToRip", ctypes.c_uint64),
        ("LastExceptionFromRip", ctypes.c_uint64),
    ]


if os.name == "nt":
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.SetInformationJobObject.restype = wintypes.BOOL
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.AssignProcessToJobObject.restype = wintypes.BOOL
    k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.TerminateJobObject.restype = wintypes.BOOL
    k32.CreateProcessW.restype = wintypes.BOOL
    k32.ResumeThread.argtypes = [wintypes.HANDLE]
    k32.ResumeThread.restype = wintypes.DWORD
    k32.WaitForDebugEvent.argtypes = [ctypes.POINTER(DEBUG_EVENT), wintypes.DWORD]
    k32.WaitForDebugEvent.restype = wintypes.BOOL
    k32.ContinueDebugEvent.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
    k32.ContinueDebugEvent.restype = wintypes.BOOL
    k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.OpenThread.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.ReadProcessMemory.restype = wintypes.BOOL
    k32.WriteProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k32.WriteProcessMemory.restype = wintypes.BOOL
    k32.FlushInstructionCache.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t]
    k32.FlushInstructionCache.restype = wintypes.BOOL
    k32.IsWow64Process.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    k32.IsWow64Process.restype = wintypes.BOOL
    k32.Wow64GetThreadContext.argtypes = [wintypes.HANDLE, ctypes.POINTER(WOW64_CONTEXT)]
    k32.Wow64GetThreadContext.restype = wintypes.BOOL
    k32.Wow64SetThreadContext.argtypes = [wintypes.HANDLE, ctypes.POINTER(WOW64_CONTEXT)]
    k32.Wow64SetThreadContext.restype = wintypes.BOOL
    k32.GetThreadContext.argtypes = [wintypes.HANDLE, ctypes.POINTER(CONTEXT64)]
    k32.GetThreadContext.restype = wintypes.BOOL
    k32.SetThreadContext.argtypes = [wintypes.HANDLE, ctypes.POINTER(CONTEXT64)]
    k32.SetThreadContext.restype = wintypes.BOOL
    k32.GetFinalPathNameByHandleW.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    k32.GetFinalPathNameByHandleW.restype = wintypes.DWORD


def read_mem(h_proc, addr: int, size: int) -> bytes:
    if not addr or size <= 0:
        return b""
    buf = ctypes.create_string_buffer(size)
    nread = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(h_proc, ctypes.c_void_p(addr), buf, size, ctypes.byref(nread))
    if not ok or nread.value == 0:
        return b""
    return buf.raw[: nread.value]


def write_mem(h_proc, addr: int, data: bytes) -> bool:
    nw = ctypes.c_size_t(0)
    buf = ctypes.create_string_buffer(data, len(data))
    ok = k32.WriteProcessMemory(h_proc, ctypes.c_void_p(addr), buf, len(data), ctypes.byref(nw))
    if ok and nw.value == len(data):
        k32.FlushInstructionCache(h_proc, ctypes.c_void_p(addr), len(data))
        return True
    return False


def read_cstr(h_proc, addr: int, max_len: int = 260) -> str:
    raw = read_mem(h_proc, addr, max_len)
    if not raw:
        return ""
    nul = raw.find(b"\x00")
    if nul >= 0:
        raw = raw[:nul]
    return raw.decode("mbcs", "replace")


def read_wstr(h_proc, addr: int, max_chars: int = 260) -> str:
    raw = read_mem(h_proc, addr, max_chars * 2)
    if len(raw) < 2:
        return ""
    for i in range(0, len(raw) - 1, 2):
        if raw[i] == 0 and raw[i + 1] == 0:
            raw = raw[:i]
            break
    return raw[: len(raw) - (len(raw) % 2)].decode("utf-16le", "replace")


def alloc_aligned_context64():
    raw_buf = ctypes.create_string_buffer(ctypes.sizeof(CONTEXT64) + 32)
    base_addr = ctypes.addressof(raw_buf)
    aligned = (base_addr + 15) & ~15
    ctx = CONTEXT64.from_address(aligned)
    return raw_buf, ctx


def get_thread_ctx(h_thread, is_wow64: bool):
    if is_wow64:
        ctx = WOW64_CONTEXT()
        ctx.ContextFlags = WOW64_CONTEXT_ALL
        if not k32.Wow64GetThreadContext(h_thread, ctypes.byref(ctx)):
            raise OSError(ctypes.get_last_error(), "Wow64GetThreadContext failed")
        return ctx, None
    holder, ctx = alloc_aligned_context64()
    ctx.ContextFlags = AMD64_CONTEXT_ALL
    if not k32.GetThreadContext(h_thread, ctypes.byref(ctx)):
        raise OSError(ctypes.get_last_error(), "GetThreadContext failed")
    return ctx, holder


def set_thread_ctx(h_thread, ctx, is_wow64: bool):
    if is_wow64:
        if not k32.Wow64SetThreadContext(h_thread, ctypes.byref(ctx)):
            raise OSError(ctypes.get_last_error(), "Wow64SetThreadContext failed")
    else:
        if not k32.SetThreadContext(h_thread, ctypes.byref(ctx)):
            raise OSError(ctypes.get_last_error(), "SetThreadContext failed")


def parse_pe_module_info(h_proc, base_addr: int):
    hdr = read_mem(h_proc, base_addr, 0x1000)
    if len(hdr) < 0x100 or hdr[:2] != b"MZ":
        return None
    e_lfanew = struct.unpack_from("<I", hdr, 0x3C)[0]
    if e_lfanew + 0x100 > len(hdr) or hdr[e_lfanew : e_lfanew + 4] != b"PE\x00\x00":
        return None
    magic = struct.unpack_from("<H", hdr, e_lfanew + 24)[0]
    is_pe64 = magic == 0x20B
    n_sec = struct.unpack_from("<H", hdr, e_lfanew + 6)[0]
    opt_size = struct.unpack_from("<H", hdr, e_lfanew + 20)[0]
    sec_off = e_lfanew + 24 + opt_size
    size_of_image = struct.unpack_from("<I", hdr, e_lfanew + 24 + 56)[0]
    exec_ranges = []
    for i in range(min(n_sec, 32)):
        off = sec_off + i * 40
        if off + 40 > len(hdr):
            break
        vsize, rva, rsize = struct.unpack_from("<III", hdr, off + 8)
        chars = struct.unpack_from("<I", hdr, off + 36)[0]
        if chars & 0x20000000:
            span = max(vsize, rsize)
            exec_ranges.append((base_addr + rva, base_addr + rva + span))
    exp_dd_off = e_lfanew + 24 + (112 if is_pe64 else 96)
    exp_rva, exp_size = struct.unpack_from("<II", hdr, exp_dd_off)
    return {
        "base": base_addr,
        "end": base_addr + size_of_image,
        "is_pe64": is_pe64,
        "exec_ranges": exec_ranges,
        "exp_rva": exp_rva,
        "exp_size": exp_size,
    }


def parse_exports(h_proc, mod_info, wanted_names):
    exp_rva = mod_info["exp_rva"]
    exp_size = mod_info["exp_size"]
    base = mod_info["base"]
    if not exp_rva or exp_size < 40:
        return "", {}
    dir_raw = read_mem(h_proc, base + exp_rva, 40)
    if len(dir_raw) < 40:
        return "", {}
    name_rva, ord_base, n_funcs, n_names, addr_tbl_rva, name_ptr_rva, ord_tbl_rva = struct.unpack_from(
        "<IIIIIII", dir_raw, 12
    )
    dll_name = read_cstr(h_proc, base + name_rva, 128).lower()
    if not any(tag in dll_name for tag in ("kernelbase", "kernel32")):
        return dll_name, {}

    name_ptrs = read_mem(h_proc, base + name_ptr_rva, n_names * 4)
    ords = read_mem(h_proc, base + ord_tbl_rva, n_names * 2)
    addrs = read_mem(h_proc, base + addr_tbl_rva, n_funcs * 4)
    if len(name_ptrs) < n_names * 4 or len(ords) < n_names * 2 or len(addrs) < n_funcs * 4:
        return dll_name, {}

    resolved = {}
    for idx in range(n_names):
        nrva = struct.unpack_from("<I", name_ptrs, idx * 4)[0]
        fname = read_cstr(h_proc, base + nrva, 96)
        if fname in wanted_names:
            o = struct.unpack_from("<H", ords, idx * 2)[0]
            if o < n_funcs:
                frva = struct.unpack_from("<I", addrs, o * 4)[0]
                if not (exp_rva <= frva < exp_rva + exp_size):
                    resolved[fname] = base + frva
    return dll_name, resolved


class Win32Tracer:
    TARGET_APIS = {
        "CreateFileW",
        "CreateFileA",
        "GetFileAttributesW",
        "GetFileAttributesA",
        "FindFirstFileW",
        "ReadFile",
        "SetFilePointer",
        "SetFilePointerEx",
        "CloseHandle",
    }

    def __init__(self, args):
        self.args = args
        self.h_proc = None
        self.h_job = None
        self.is_wow64 = False
        self.ptr_size = 8
        self.preferred_image_base = read_pe_preferred_image_base(args.exe)
        self.main_mod = None
        self.modules = []
        self.threads = {}
        self.bps = {}  # addr -> orig_byte
        self.bp_handlers = {}  # addr -> (kind, meta)
        self.pending_step = {}  # tid -> restore_addr
        self.open_handles = {}  # handle -> {"path": str, "offset": int}
        self.events = []
        self.matched_events_count = 0
        self.unmatched_events_count = 0
        self.watch_armed = False
        self.watch_buf_base = 0
        self.watch_addr = 0
        self.watch_before_hex = ""
        self.watch_prev16_before_hex = ""
        self.watch_file = ""
        self.watch_read_offset = 0
        self.watch_hits = []
        self.watch_hit_count_by_va = {}
        self.watch_last_state_by_va = {}
        self.loose_probes = []
        self.seen_loose = set()
        self.api_hooked = set()

    def ptr_read(self, addr: int) -> int:
        raw = read_mem(self.h_proc, addr, self.ptr_size)
        if len(raw) < self.ptr_size:
            return 0
        return struct.unpack_from("<I" if self.ptr_size == 4 else "<Q", raw, 0)[0]

    def in_main_exec(self, addr: int) -> bool:
        if not self.main_mod:
            return False
        return any(lo <= addr < hi for lo, hi in self.main_mod["exec_ranges"])

    def to_static_main_va(self, runtime_va: int):
        if (
            self.main_mod
            and self.preferred_image_base is not None
            and self.main_mod["base"] <= runtime_va < self.main_mod["end"]
        ):
            return hex(self.preferred_image_base + (runtime_va - self.main_mod["base"]))
        return None

    def find_module_for_va(self, addr: int):
        for m in self.modules:
            if m["base"] <= addr < m["end"]:
                return m
        return None

    def capture_main_callers(self, ctx):
        sp = ctx.Esp if self.is_wow64 else ctx.Rsp
        raw = read_mem(self.h_proc, sp, self.ptr_size * 48)
        callers_va = []
        callers_static_va = []
        is_64 = not self.is_wow64
        for i in range(0, len(raw) - self.ptr_size + 1, self.ptr_size):
            val = struct.unpack_from("<I" if self.ptr_size == 4 else "<Q", raw, i)[0]
            if not self.in_main_exec(val):
                continue
            tail7 = read_mem(self.h_proc, val - 7, 7) if val >= 7 else b""
            if not is_call_preceding_bytes(tail7, is_64=is_64):
                continue
            h = hex(val)
            if h not in callers_va:
                callers_va.append(h)
                s_va = self.to_static_main_va(val)
                if s_va:
                    callers_static_va.append(s_va)
                if len(callers_va) >= 4:
                    break
        return callers_va, callers_static_va

    def add_bp(self, addr: int, kind: str, meta=None):
        if addr in self.bps:
            self.bp_handlers[addr] = (kind, meta)
            return True
        orig = read_mem(self.h_proc, addr, 1)
        if len(orig) != 1:
            return False
        if write_mem(self.h_proc, addr, b"\xcc"):
            self.bps[addr] = orig
            self.bp_handlers[addr] = (kind, meta)
            return True
        return False

    def remove_bp(self, addr: int):
        orig = self.bps.pop(addr, None)
        self.bp_handlers.pop(addr, None)
        if orig is not None:
            write_mem(self.h_proc, addr, orig)

    def read_api_args(self, ctx, count: int):
        if self.is_wow64:
            ret_addr = self.ptr_read(ctx.Esp)
            args = [self.ptr_read(ctx.Esp + 4 * (i + 1)) for i in range(count)]
            return ret_addr, args
        ret_addr = self.ptr_read(ctx.Rsp)
        reg_args = [ctx.Rcx, ctx.Rdx, ctx.R8, ctx.R9]
        args = []
        for i in range(count):
            if i < 4:
                args.append(reg_args[i])
            else:
                args.append(self.ptr_read(ctx.Rsp + 8 * (i + 1)))
        return ret_addr, args

    def match_target(self, path_str: str) -> bool:
        flt = (self.args.target_filter or "").strip().lower()
        if not flt:
            return True
        return flt in path_str.lower()

    def record_io_event(self, kind: str, path_str: str, ctx, extra=None):
        matched = self.match_target(path_str)
        has_filter = bool((self.args.target_filter or "").strip())

        if kind in ("GetFileAttributesW", "GetFileAttributesA", "FindFirstFileW") and len(self.loose_probes) < 25:
            low = path_str.lower()
            if not low.endswith((".dll", ".mui", ".nls", ".exe")):
                if low not in self.seen_loose:
                    self.seen_loose.add(low)
                    callers_va, callers_static = self.capture_main_callers(ctx)
                    self.loose_probes.append(
                        {
                            "api": kind,
                            "path": path_str,
                            "callers_va": callers_va,
                            "callers_static_va": callers_static,
                        }
                    )

        if has_filter:
            if not matched:
                if is_os_noise_path(path_str) or self.unmatched_events_count >= 15:
                    return
                self.unmatched_events_count += 1
            else:
                if self.matched_events_count >= self.args.max_events:
                    return
                self.matched_events_count += 1
        else:
            if len(self.events) >= self.args.max_events:
                return
            if not matched and len(self.events) > 25 and kind in ("GetFileAttributesW", "GetFileAttributesA"):
                return

        if len(self.events) >= self.args.max_events + 20:
            return

        callers_va, callers_static = self.capture_main_callers(ctx)
        ev = {
            "api": kind,
            "path": path_str,
            "matched_filter": matched,
            "callers_va": callers_va,
            "callers_static_va": callers_static,
        }
        if extra:
            ev.update(extra)
        self.events.append(ev)

    def on_load_dll(self, info):
        base = ctypes.c_void_p(info.lpBaseOfDll).value
        if not base:
            return
        mod = parse_pe_module_info(self.h_proc, base)
        dll_path = ""
        if info.hFile:
            buf = ctypes.create_unicode_buffer(MAX_PATH_CHARS)
            n = k32.GetFinalPathNameByHandleW(info.hFile, buf, MAX_PATH_CHARS, 0)
            if n > 0:
                dll_path = buf.value
            k32.CloseHandle(info.hFile)
        if not mod:
            return
        mod["name"] = os.path.basename(dll_path) if dll_path else ""
        self.modules.append(mod)
        low_path = dll_path.lower()
        if "kernelbase.dll" in low_path or "kernel32.dll" in low_path:
            dll_name, exps = parse_exports(self.h_proc, mod, self.TARGET_APIS)
            if not mod["name"]:
                mod["name"] = dll_name
            for fname, va in exps.items():
                if "kernelbase" in (dll_name or low_path) or fname not in self.api_hooked:
                    if self.add_bp(va, "api", fname):
                        self.api_hooked.add(fname)

    def handle_api_entry(self, tid: int, h_thread, ctx, api_name: str):
        ret_addr, args = self.read_api_args(ctx, 5)
        if api_name in ("CreateFileW", "CreateFileA"):
            p = read_wstr(self.h_proc, args[0]) if api_name.endswith("W") else read_cstr(self.h_proc, args[0])
            if p:
                self.record_io_event(api_name, p, ctx)
                if self.match_target(p) and ret_addr:
                    self.add_bp(ret_addr, "ret", ("CreateFile_ret", tid, p))
        elif api_name in ("GetFileAttributesW", "GetFileAttributesA", "FindFirstFileW"):
            p = read_wstr(self.h_proc, args[0]) if api_name.endswith("W") else read_cstr(self.h_proc, args[0])
            if p:
                self.record_io_event(api_name, p, ctx)
        elif api_name == "CloseHandle":
            self.open_handles.pop(args[0], None)
        elif api_name == "SetFilePointer":
            h = args[0]
            if h in self.open_handles:
                dist_lo = ctypes.c_int32(args[1]).value
                method = args[3]
                if method == 0:
                    self.open_handles[h]["offset"] = max(0, dist_lo)
                elif method == 1:
                    self.open_handles[h]["offset"] = max(0, self.open_handles[h]["offset"] + dist_lo)
        elif api_name == "SetFilePointerEx":
            h = args[0]
            if h in self.open_handles:
                if self.is_wow64:
                    # stdcall 32-bit: LARGE_INTEGER takes two 32-bit stack slots (Low, High), followed by lpNewFilePointer, dwMoveMethod
                    dist = struct.unpack("<q", struct.pack("<II", args[1], args[2]))[0]
                    method = args[4]
                else:
                    dist = struct.unpack("<q", struct.pack("<Q", args[1]))[0]
                    method = args[3]
                if method == 0:
                    self.open_handles[h]["offset"] = max(0, dist)
                elif method == 1:
                    self.open_handles[h]["offset"] = max(0, self.open_handles[h]["offset"] + dist)
        elif api_name == "ReadFile":
            h, buf_ptr, to_read, nread_ptr = args[0], args[1], args[2], args[3]
            info = self.open_handles.get(h)
            if info and self.match_target(info["path"]) and ret_addr:
                cur_off = info["offset"]
                if cur_off >= self.args.min_offset and (self.args.max_offset < 0 or cur_off <= self.args.max_offset):
                    if to_read >= self.args.min_size:
                        self.add_bp(
                            ret_addr,
                            "ret",
                            ("ReadFile_ret", tid, h, info["path"], cur_off, buf_ptr, to_read, nread_ptr),
                        )

    def handle_ret_bp(self, tid: int, h_thread, ctx, meta):
        kind = meta[0]
        if kind == "CreateFile_ret":
            _, orig_tid, p = meta
            if tid != orig_tid:
                return
            handle_val = ctx.Eax if self.is_wow64 else ctx.Rax
            invalid = 0xFFFFFFFF if self.is_wow64 else 0xFFFFFFFFFFFFFFFF
            if handle_val and handle_val != invalid:
                self.open_handles[handle_val] = {"path": p, "offset": 0}
        elif kind == "ReadFile_ret":
            _, orig_tid, h, p, cur_off, buf_ptr, to_read, nread_ptr = meta
            if tid != orig_tid:
                return
            ok_ret = ctx.Eax if self.is_wow64 else ctx.Rax
            actual_read = to_read
            if nread_ptr:
                raw_n = read_mem(self.h_proc, nread_ptr, 4)
                if len(raw_n) == 4:
                    actual_read = struct.unpack("<I", raw_n)[0]
            if h in self.open_handles and ok_ret:
                self.open_handles[h]["offset"] = cur_off + actual_read
            sample = read_mem(self.h_proc, buf_ptr, min(32, actual_read))
            self.record_io_event(
                "ReadFile",
                p,
                ctx,
                {
                    "file_offset": cur_off,
                    "requested": to_read,
                    "actual_read": actual_read,
                    "buf_addr": hex(buf_ptr),
                    "head_hex": sample.hex(),
                },
            )
            if (
                self.args.mode == "read_watch"
                and not self.watch_armed
                and ok_ret
                and actual_read > self.args.watch_offset
            ):
                waddr = buf_ptr + self.args.watch_offset
                before = read_mem(self.h_proc, waddr, 32)
                prev_start = max(buf_ptr, waddr - 16)
                prev_len = max(0, waddr - prev_start)
                prev16_before = read_mem(self.h_proc, prev_start, prev_len).hex() if prev_len > 0 else ""
                self.watch_armed = True
                self.watch_buf_base = buf_ptr
                self.watch_addr = waddr
                self.watch_before_hex = before.hex()
                self.watch_prev16_before_hex = prev16_before
                self.watch_file = p
                self.watch_read_offset = cur_off + self.args.watch_offset
                ctx.Dr0 = waddr & (0xFFFFFFFF if self.is_wow64 else 0xFFFFFFFFFFFFFFFF)
                # Enable DR0 local (bit 0), RW access (11b at bits 16..17), length 4 bytes (11b at bits 18..19) -> 0x000F0001
                ctx.Dr7 = (ctx.Dr7 & ~0x000F0003) | 0x000F0001
                ctx.Dr6 = 0
                set_thread_ctx(h_thread, ctx, self.is_wow64)

    def handle_hw_watch(self, h_thread, ctx, exc_addr: int):
        hit_count = self.watch_hit_count_by_va.get(exc_addr, 0)
        after = read_mem(self.h_proc, self.watch_addr, 32).hex()
        prev_start = max(self.watch_buf_base, self.watch_addr - 16)
        prev_len = max(0, self.watch_addr - prev_start)
        prev16 = read_mem(self.h_proc, prev_start, prev_len).hex() if prev_len > 0 else ""
        prev_state = self.watch_last_state_by_va.get(exc_addr)
        should_record = hit_count == 0 or (
            hit_count < 2 and prev_state is not None and (after, prev16) != prev_state
        )
        if should_record:
            self.watch_hit_count_by_va[exc_addr] = hit_count + 1
            self.watch_last_state_by_va[exc_addr] = (after, prev16)
            mod = self.find_module_for_va(exc_addr)
            mod_name = mod.get("name", "") if mod else ""
            rva_hex = hex(exc_addr - mod["base"]) if mod else None
            callers_va, callers_static = self.capture_main_callers(ctx)
            if self.is_wow64:
                regs = {
                    "eax": hex(ctx.Eax),
                    "ecx": hex(ctx.Ecx),
                    "edx": hex(ctx.Edx),
                    "ebx": hex(ctx.Ebx),
                    "esi": hex(ctx.Esi),
                    "edi": hex(ctx.Edi),
                }
            else:
                regs = {
                    "rax": hex(ctx.Rax),
                    "rcx": hex(ctx.Rcx),
                    "rdx": hex(ctx.Rdx),
                    "rbx": hex(ctx.Rbx),
                    "rsi": hex(ctx.Rsi),
                    "rdi": hex(ctx.Rdi),
                }
            self.watch_hits.append(
                {
                    "insn_va": hex(exc_addr),
                    "static_va": self.to_static_main_va(exc_addr),
                    "module": mod_name,
                    "rva": rva_hex,
                    "in_main_exe": self.in_main_exec(exc_addr),
                    "callers_va": callers_va,
                    "callers_static_va": callers_static,
                    "regs": regs,
                    "prev16_hex": prev16,
                    "after_hex": after,
                    "changed_from_read": after != self.watch_before_hex,
                }
            )
        # Clear DR6 status and set Resume Flag (RF bit 16) to skip re-triggering on same instruction
        ctx.Dr6 = 0
        ctx.EFlags |= 0x10000
        if len(self.watch_hits) >= self.args.max_hits:
            ctx.Dr7 &= ~0x3
        set_thread_ctx(h_thread, ctx, self.is_wow64)

    def run(self):
        sa_job = k32.CreateJobObjectW(None, None)
        if not sa_job:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        self.h_job = sa_job
        jinfo = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        jinfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(
            self.h_job, JobObjectExtendedLimitInformation, ctypes.byref(jinfo), ctypes.sizeof(jinfo)
        ):
            raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

        si = STARTUPINFOW()
        si.cb = ctypes.sizeof(STARTUPINFOW)
        pi = PROCESS_INFORMATION()
        flags = DEBUG_ONLY_THIS_PROCESS | CREATE_SUSPENDED | CREATE_NO_WINDOW
        ok = k32.CreateProcessW(
            self.args.exe,
            None,
            None,
            None,
            False,
            flags,
            None,
            self.args.cwd,
            ctypes.byref(si),
            ctypes.byref(pi),
        )
        if not ok:
            raise OSError(ctypes.get_last_error(), f"CreateProcessW failed for {self.args.exe}")

        self.h_proc = pi.hProcess
        self.threads[pi.dwThreadId] = pi.hThread
        k32.AssignProcessToJobObject(self.h_job, self.h_proc)

        wow = wintypes.BOOL(False)
        k32.IsWow64Process(self.h_proc, ctypes.byref(wow))
        self.is_wow64 = bool(wow.value)
        self.ptr_size = 4 if self.is_wow64 else 8
        k32.ResumeThread(pi.hThread)

        deadline = time.monotonic() + self.args.timeout_sec
        stop_reason = "completed"
        seen_init_bp = False
        ev = DEBUG_EVENT()

        while True:
            rem_ms = int((deadline - time.monotonic()) * 1000)
            if rem_ms <= 0:
                stop_reason = "timeout"
                break
            if not k32.WaitForDebugEvent(ctypes.byref(ev), min(rem_ms, 250)):
                continue

            code = ev.dwDebugEventCode
            tid = ev.dwThreadId
            cont_status = DBG_CONTINUE

            if code == CREATE_PROCESS_DEBUG_EVENT:
                cp = ev.u.CreateProcessInfo
                base = ctypes.c_void_p(cp.lpBaseOfImage).value
                self.main_mod = parse_pe_module_info(self.h_proc, base)
                if self.main_mod:
                    self.main_mod["name"] = os.path.basename(self.args.exe)
                    self.modules.append(self.main_mod)
                if cp.hFile:
                    k32.CloseHandle(cp.hFile)
            elif code == CREATE_THREAD_DEBUG_EVENT:
                self.threads[tid] = ev.u.CreateThread.hThread
            elif code == EXIT_THREAD_DEBUG_EVENT:
                self.threads.pop(tid, None)
            elif code == LOAD_DLL_DEBUG_EVENT:
                self.on_load_dll(ev.u.LoadDll)
            elif code == EXIT_PROCESS_DEBUG_EVENT:
                stop_reason = f"process_exit:{ev.u.ExitProcess.dwExitCode}"
                k32.ContinueDebugEvent(ev.dwProcessId, tid, DBG_CONTINUE)
                break
            elif code == EXCEPTION_DEBUG_EVENT:
                exc = ev.u.Exception.ExceptionRecord
                exc_code = exc.ExceptionCode
                exc_addr = ctypes.c_void_p(exc.ExceptionAddress).value or 0
                h_thread = self.threads.get(tid) or k32.OpenThread(THREAD_ALL_ACCESS, False, tid)
                if h_thread:
                    self.threads[tid] = h_thread

                if exc_code in (EXCEPTION_BREAKPOINT, STATUS_WX86_BREAKPOINT):
                    if not seen_init_bp and exc_addr not in self.bps:
                        seen_init_bp = True
                    elif exc_addr in self.bps and h_thread:
                        ctx, _holder = get_thread_ctx(h_thread, self.is_wow64)
                        kind, meta = self.bp_handlers.get(exc_addr, (None, None))
                        if kind == "api":
                            self.handle_api_entry(tid, h_thread, ctx, meta)
                            # Re-wind IP to exc_addr, restore orig byte temporarily, single-step
                            if self.is_wow64:
                                ctx.Eip = exc_addr
                            else:
                                ctx.Rip = exc_addr
                            orig = self.bps[exc_addr]
                            write_mem(self.h_proc, exc_addr, orig)
                            ctx.EFlags |= 0x100  # Trap Flag
                            set_thread_ctx(h_thread, ctx, self.is_wow64)
                            self.pending_step[tid] = exc_addr
                        elif kind == "ret":
                            self.handle_ret_bp(tid, h_thread, ctx, meta)
                            if self.is_wow64:
                                ctx.Eip = exc_addr
                            else:
                                ctx.Rip = exc_addr
                            self.remove_bp(exc_addr)
                            set_thread_ctx(h_thread, ctx, self.is_wow64)
                    else:
                        cont_status = DBG_EXCEPTION_NOT_HANDLED if ev.u.Exception.dwFirstChance else DBG_CONTINUE
                elif exc_code in (EXCEPTION_SINGLE_STEP, STATUS_WX86_SINGLE_STEP) and h_thread:
                    ctx, _holder = get_thread_ctx(h_thread, self.is_wow64)
                    if tid in self.pending_step:
                        restore_addr = self.pending_step.pop(tid)
                        if restore_addr in self.bps:
                            write_mem(self.h_proc, restore_addr, b"\xcc")
                        ctx.EFlags &= ~0x100
                        set_thread_ctx(h_thread, ctx, self.is_wow64)
                    elif self.watch_armed and (ctx.Dr6 & 0x1):
                        self.handle_hw_watch(h_thread, ctx, exc_addr)
                    else:
                        cont_status = DBG_EXCEPTION_NOT_HANDLED
                else:
                    cont_status = DBG_EXCEPTION_NOT_HANDLED

            k32.ContinueDebugEvent(ev.dwProcessId, tid, cont_status)

            if self.args.mode == "read_watch" and len(self.watch_hits) >= self.args.max_hits:
                stop_reason = "watch_hits_collected"
                break
            has_filter = bool((self.args.target_filter or "").strip())
            io_target_count = self.matched_events_count if has_filter else len(self.events)
            if self.args.mode == "io_trace" and io_target_count >= self.args.max_events:
                stop_reason = "max_events_collected"
                break

        return {
            "ok": True,
            "supported": True,
            "mode": self.args.mode,
            "arch": "x86" if self.is_wow64 else "x64",
            "stop_reason": stop_reason,
            "main_image_base": hex(self.main_mod["base"]) if self.main_mod else None,
            "preferred_image_base": hex(self.preferred_image_base) if self.preferred_image_base is not None else None,
            "hooked_apis": sorted(self.api_hooked),
            "loose_file_probes": self.loose_probes[:20],
            "io_events": self.events[:60],
            "read_watch": {
                "armed": self.watch_armed,
                "file": self.watch_file,
                "read_offset": self.watch_read_offset,
                "watch_addr": hex(self.watch_addr) if self.watch_addr else None,
                "prev16_before_hex": self.watch_prev16_before_hex,
                "before_hex": self.watch_before_hex,
                "hits": self.watch_hits,
            },
        }

    def close(self):
        if self.h_job:
            try:
                k32.TerminateJobObject(self.h_job, 0)
            except Exception:
                pass
            k32.CloseHandle(self.h_job)
            self.h_job = None


def main():
    parser = argparse.ArgumentParser(description="Controlled Win32 API & DR0 hardware-breakpoint tracer")
    parser.add_argument("--exe", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--mode", choices=["io_trace", "read_watch"], default="io_trace")
    parser.add_argument("--target-filter", default="")
    parser.add_argument("--min-offset", type=int, default=0)
    parser.add_argument("--max-offset", type=int, default=-1)
    parser.add_argument("--min-size", type=int, default=1)
    parser.add_argument("--watch-offset", type=int, default=0)
    parser.add_argument("--max-events", type=int, default=80)
    parser.add_argument("--max-hits", type=int, default=12)
    parser.add_argument("--timeout-sec", type=int, default=20)
    args = parser.parse_args()

    tracer = Win32Tracer(args)
    try:
        res = tracer.run()
    except Exception as ex:
        res = {"ok": False, "supported": True, "error": str(ex)}
    finally:
        tracer.close()
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
