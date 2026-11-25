#include "proxy_core.h"
#include <tlhelp32.h>

#ifndef SHIFTJIS_CHARSET
#define SHIFTJIS_CHARSET 0x80
#endif

#ifndef GB2312_CHARSET
#define GB2312_CHARSET 0x86
#endif

#ifndef LF_FACESIZE
#define LF_FACESIZE 32
#endif

#ifndef WC_NO_BEST_FIT_CHARS
#define WC_NO_BEST_FIT_CHARS 0x00000400
#endif

#ifndef PC_CP_UTF8
#define PC_CP_UTF8 65001
#endif

#ifndef PC_CP_GB18030
#define PC_CP_GB18030 54936
#endif

#define PC_ARRAY_LEN(arr) (sizeof(arr) / sizeof((arr)[0]))

/* --- Zero-CRT memory and string helpers --- */

#if defined(__GNUC__) && !defined(__clang__)
#define PC_NO_LOOP_DIST __attribute__((optimize("no-tree-loop-distribute-patterns")))
#else
#define PC_NO_LOOP_DIST
#endif

PC_NO_LOOP_DIST
static void pc_memset(void* dst, int val, size_t len) {
    unsigned char* p = (unsigned char*)dst;
    size_t i;
    for (i = 0; i < len; ++i) {
        p[i] = (unsigned char)val;
    }
}

PC_NO_LOOP_DIST
static void pc_memcpy(void* dst, const void* src, size_t len) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    size_t i;
    for (i = 0; i < len; ++i) {
        d[i] = s[i];
    }
}

#ifdef PC_NOSTDLIB
PC_NO_LOOP_DIST
void* memset(void* dst, int val, size_t len) {
    unsigned char* p = (unsigned char*)dst;
    size_t i;
    for (i = 0; i < len; ++i) {
        p[i] = (unsigned char)val;
    }
    return dst;
}

PC_NO_LOOP_DIST
void* memcpy(void* dst, const void* src, size_t len) {
    unsigned char* d = (unsigned char*)dst;
    const unsigned char* s = (const unsigned char*)src;
    size_t i;
    for (i = 0; i < len; ++i) {
        d[i] = s[i];
    }
    return dst;
}
#endif

static size_t pc_wcslen(const WCHAR* s) {
    size_t n = 0;
    if (!s) return 0;
    while (s[n] != L'\0') {
        ++n;
    }
    return n;
}

static void pc_wcscpy_cap(WCHAR* dst, size_t cap, const WCHAR* src) {
    size_t i = 0;
    if (!dst || cap == 0) return;
    if (src) {
        while (i + 1 < cap && src[i] != L'\0') {
            dst[i] = src[i];
            ++i;
        }
    }
    dst[i] = L'\0';
}

static char pc_tolower_a(char c) {
    if (c >= 'A' && c <= 'Z') return (char)(c + ('a' - 'A'));
    return c;
}

static WCHAR pc_tolower_w(WCHAR c) {
    if (c >= L'A' && c <= L'Z') return (WCHAR)(c + (L'a' - L'A'));
    return c;
}

static int pc_ascii_icmp(const char* a, const char* b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    while (*a && *b) {
        char ca = pc_tolower_a(*a);
        char cb = pc_tolower_a(*b);
        if (ca != cb) return (unsigned char)ca - (unsigned char)cb;
        ++a;
        ++b;
    }
    return (unsigned char)pc_tolower_a(*a) - (unsigned char)pc_tolower_a(*b);
}

static int pc_wcs_istartswith(const WCHAR* str, const WCHAR* prefix) {
    size_t i = 0;
    if (!str || !prefix || prefix[0] == L'\0') return 0;
    while (prefix[i] != L'\0') {
        WCHAR a = pc_tolower_w(str[i]);
        WCHAR b = pc_tolower_w(prefix[i]);
        if (a == L'/') a = L'\\';
        if (b == L'/') b = L'\\';
        if (a != b) return 0;
        ++i;
    }
    return 1;
}

static int pc_wcs_ieq(const WCHAR* a, const WCHAR* b) {
    size_t i = 0;
    if (!a || !b) return 0;
    while (a[i] != L'\0' && b[i] != L'\0') {
        WCHAR ca = pc_tolower_w(a[i]);
        WCHAR cb = pc_tolower_w(b[i]);
        if (ca == L'/') ca = L'\\';
        if (cb == L'/') cb = L'\\';
        if (ca != cb) return 0;
        ++i;
    }
    return a[i] == b[i];
}

static void pc_extract_dir(const WCHAR* fullPath, WCHAR* outDir, size_t outCap) {
    size_t len;
    size_t lastSep = (size_t)-1;
    size_t i;
    pc_wcscpy_cap(outDir, outCap, fullPath);
    len = pc_wcslen(outDir);
    for (i = 0; i < len; ++i) {
        if (outDir[i] == L'\\' || outDir[i] == L'/') {
            lastSep = i;
        }
    }
    if (lastSep == (size_t)-1) {
        outDir[0] = L'\0';
    } else {
        outDir[lastSep] = L'\0';
    }
}

static int pc_join_path(WCHAR* dst, size_t cap, const WCHAR* base, const WCHAR* rel) {
    size_t bLen = pc_wcslen(base);
    size_t rLen = pc_wcslen(rel);
    int needSep = (bLen > 0 && base[bLen - 1] != L'\\' && base[bLen - 1] != L'/') ? 1 : 0;
    if (bLen + (size_t)needSep + rLen + 1 > cap) return 0;
    pc_wcscpy_cap(dst, cap, base);
    if (needSep) {
        dst[bLen++] = L'\\';
        dst[bLen] = L'\0';
    }
    pc_wcscpy_cap(dst + bLen, cap - bLen, rel);
    return 1;
}

static int pc_is_regular_file(const WCHAR* path) {
    DWORD attrs = GetFileAttributesW(path);
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static int pc_is_abs_path(const WCHAR* p) {
    if (!p || p[0] == L'\0') return 0;
    if (p[0] == L'\\' || p[0] == L'/') return 1;
    if (p[1] == L':') return 1;
    return 0;
}

static size_t pc_append_str(char* dst, size_t cap, size_t pos, const char* src) {
    size_t i = 0;
    if (!src) return pos;
    while (src[i] != '\0' && pos + 1 < cap) {
        dst[pos++] = src[i++];
    }
    dst[pos] = '\0';
    return pos;
}

static size_t pc_append_u32(char* dst, size_t cap, size_t pos, UINT val) {
    char tmp[16];
    size_t n = 0;
    if (val == 0) {
        return pc_append_str(dst, cap, pos, "0");
    }
    while (val > 0 && n < sizeof(tmp)) {
        tmp[n++] = (char)('0' + (val % 10));
        val /= 10;
    }
    while (n > 0 && pos + 1 < cap) {
        dst[pos++] = tmp[--n];
    }
    dst[pos] = '\0';
    return pos;
}

/* --- Configuration & Original API Pointers --- */

typedef struct ProxyConfig {
    UINT codepage;
    UINT charset;
    WCHAR fontName[LF_FACESIZE];
    BOOL forceFontName;
    BOOL enableWidthCompat;
} ProxyConfig;

typedef struct ProxyInitScratch {
    WCHAR dllPath[520];
    WCHAR dllDir[520];
    WCHAR parentDir[520];
    WCHAR iniPath[520];
    WCHAR logPath[520];
    WCHAR mainExePath[520];
    WCHAR mainExeDir[520];
    WCHAR winDir[360];
    WCHAR modDir[520];
    MODULEENTRY32W me;
} ProxyInitScratch;

static ProxyConfig g_cfg;
static ProxyInitScratch g_scratch;
static volatile LONG g_initState = 0;

/* KERNEL32 originals */
typedef UINT (WINAPI *PFN_GetACP)(void);
typedef UINT (WINAPI *PFN_GetOEMCP)(void);
typedef BOOL (WINAPI *PFN_GetCPInfo)(UINT, LPCPINFO);
typedef BOOL (WINAPI *PFN_GetCPInfoExA)(UINT, DWORD, LPCPINFOEXA);
typedef BOOL (WINAPI *PFN_GetCPInfoExW)(UINT, DWORD, LPCPINFOEXW);
typedef int  (WINAPI *PFN_MultiByteToWideChar)(UINT, DWORD, LPCCH, int, LPWSTR, int);
typedef int  (WINAPI *PFN_WideCharToMultiByte)(UINT, DWORD, LPCWCH, int, LPSTR, int, LPCCH, LPBOOL);
typedef BOOL (WINAPI *PFN_IsDBCSLeadByte)(BYTE);
typedef BOOL (WINAPI *PFN_IsDBCSLeadByteEx)(UINT, BYTE);

/* GDI32 originals */
typedef HFONT (WINAPI *PFN_CreateFontA)(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPCSTR);
typedef HFONT (WINAPI *PFN_CreateFontW)(int, int, int, int, int, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, DWORD, LPCWSTR);
typedef HFONT (WINAPI *PFN_CreateFontIndirectA)(const LOGFONTA*);
typedef HFONT (WINAPI *PFN_CreateFontIndirectW)(const LOGFONTW*);
typedef int   (WINAPI *PFN_EnumFontFamiliesExA)(HDC, LPLOGFONTA, FONTENUMPROCA, LPARAM, DWORD);
typedef int   (WINAPI *PFN_EnumFontFamiliesExW)(HDC, LPLOGFONTW, FONTENUMPROCW, LPARAM, DWORD);
typedef int   (WINAPI *PFN_EnumFontFamiliesA)(HDC, LPCSTR, FONTENUMPROCA, LPARAM);
typedef int   (WINAPI *PFN_EnumFontFamiliesW)(HDC, LPCWSTR, FONTENUMPROCW, LPARAM);

/* USER32 originals */
typedef LPSTR (WINAPI *PFN_CharNextExA)(WORD, LPCSTR, DWORD);

static PFN_GetACP               orig_GetACP = NULL;
static PFN_GetOEMCP             orig_GetOEMCP = NULL;
static PFN_GetCPInfo            orig_GetCPInfo = NULL;
static PFN_GetCPInfoExA         orig_GetCPInfoExA = NULL;
static PFN_GetCPInfoExW         orig_GetCPInfoExW = NULL;
static PFN_MultiByteToWideChar  orig_MultiByteToWideChar = NULL;
static PFN_WideCharToMultiByte  orig_WideCharToMultiByte = NULL;
static PFN_IsDBCSLeadByte       orig_IsDBCSLeadByte = NULL;
static PFN_IsDBCSLeadByteEx     orig_IsDBCSLeadByteEx = NULL;

static PFN_CreateFontA          orig_CreateFontA = NULL;
static PFN_CreateFontW          orig_CreateFontW = NULL;
static PFN_CreateFontIndirectA  orig_CreateFontIndirectA = NULL;
static PFN_CreateFontIndirectW  orig_CreateFontIndirectW = NULL;
static PFN_EnumFontFamiliesExA  orig_EnumFontFamiliesExA = NULL;
static PFN_EnumFontFamiliesExW  orig_EnumFontFamiliesExW = NULL;
static PFN_EnumFontFamiliesA    orig_EnumFontFamiliesA = NULL;
static PFN_EnumFontFamiliesW    orig_EnumFontFamiliesW = NULL;

static PFN_CharNextExA          orig_CharNextExA = NULL;

/* --- Hook Helpers & Wrappers --- */

static UINT RemapCodePage(UINT cp) {
    if (g_cfg.codepage > 0 && (cp == CP_ACP || cp == 932)) {
        return g_cfg.codepage;
    }
    return cp;
}

static BOOL RewriteFaceNameA(char* dst, int dstCap) {
    UINT cp;
    int written;
    if (!dst || dstCap <= 0 || g_cfg.fontName[0] == L'\0' || !orig_WideCharToMultiByte) {
        return FALSE;
    }
    cp = (g_cfg.codepage > 0) ? g_cfg.codepage : CP_ACP;
    written = orig_WideCharToMultiByte(cp, 0, g_cfg.fontName, -1, dst, dstCap, NULL, NULL);
    if (written <= 0) {
        return FALSE;
    }
    dst[dstCap - 1] = '\0';
    return TRUE;
}

/* KERNEL32 wrappers */

static UINT WINAPI Hook_GetACP(void) {
    if (g_cfg.codepage > 0) return g_cfg.codepage;
    return orig_GetACP ? orig_GetACP() : 936;
}

static UINT WINAPI Hook_GetOEMCP(void) {
    if (g_cfg.codepage > 0) return g_cfg.codepage;
    return orig_GetOEMCP ? orig_GetOEMCP() : 936;
}

static BOOL WINAPI Hook_GetCPInfo(UINT CodePage, LPCPINFO lpCPInfo) {
    return orig_GetCPInfo ? orig_GetCPInfo(RemapCodePage(CodePage), lpCPInfo) : FALSE;
}

static BOOL WINAPI Hook_GetCPInfoExA(UINT CodePage, DWORD dwFlags, LPCPINFOEXA lpCPInfoEx) {
    return orig_GetCPInfoExA ? orig_GetCPInfoExA(RemapCodePage(CodePage), dwFlags, lpCPInfoEx) : FALSE;
}

static BOOL WINAPI Hook_GetCPInfoExW(UINT CodePage, DWORD dwFlags, LPCPINFOEXW lpCPInfoEx) {
    return orig_GetCPInfoExW ? orig_GetCPInfoExW(RemapCodePage(CodePage), dwFlags, lpCPInfoEx) : FALSE;
}

static int WINAPI Hook_MultiByteToWideChar(
    UINT CodePage, DWORD dwFlags, LPCCH lpMultiByteStr, int cbMultiByte,
    LPWSTR lpWideCharStr, int cchWideChar)
{
    UINT mappedCp = RemapCodePage(CodePage);
    DWORD safeFlags = dwFlags;
    if (mappedCp != CodePage && (mappedCp == PC_CP_UTF8 || mappedCp == PC_CP_GB18030)) {
        safeFlags &= (DWORD)MB_ERR_INVALID_CHARS;
    }
    return orig_MultiByteToWideChar(
        mappedCp, safeFlags, lpMultiByteStr, cbMultiByte, lpWideCharStr, cchWideChar);
}

static int WINAPI Hook_WideCharToMultiByte(
    UINT CodePage, DWORD dwFlags, LPCWCH lpWideCharStr, int cchWideChar,
    LPSTR lpMultiByteStr, int cbMultiByte, LPCCH lpDefaultChar, LPBOOL lpUsedDefaultChar)
{
    UINT mappedCp = RemapCodePage(CodePage);
    DWORD safeFlags = dwFlags;
    if (mappedCp != CodePage) {
        safeFlags &= ~(DWORD)WC_NO_BEST_FIT_CHARS;
        if (mappedCp == PC_CP_UTF8 || mappedCp == PC_CP_GB18030) {
            safeFlags = 0;
            lpDefaultChar = NULL;
            lpUsedDefaultChar = NULL;
        }
    }
    return orig_WideCharToMultiByte(
        mappedCp, safeFlags, lpWideCharStr, cchWideChar,
        lpMultiByteStr, cbMultiByte, lpDefaultChar, lpUsedDefaultChar);
}

static BOOL WINAPI Hook_IsDBCSLeadByte(BYTE TestChar) {
    if (g_cfg.codepage > 0 && orig_IsDBCSLeadByteEx) {
        return orig_IsDBCSLeadByteEx(g_cfg.codepage, TestChar);
    }
    return orig_IsDBCSLeadByte ? orig_IsDBCSLeadByte(TestChar) : FALSE;
}

static BOOL WINAPI Hook_IsDBCSLeadByteEx(UINT CodePage, BYTE TestChar) {
    return orig_IsDBCSLeadByteEx ? orig_IsDBCSLeadByteEx(RemapCodePage(CodePage), TestChar) : FALSE;
}

/* GDI32 wrappers */

static HFONT WINAPI Hook_CreateFontA(
    int cHeight, int cWidth, int cEscapement, int cOrientation, int cWeight,
    DWORD bItalic, DWORD bUnderline, DWORD bStrikeOut, DWORD iCharSet,
    DWORD iOutPrecision, DWORD iClipPrecision, DWORD iQuality,
    DWORD iPitchAndFamily, LPCSTR pszFaceName)
{
    char faceBuf[LF_FACESIZE];
    if (iCharSet == SHIFTJIS_CHARSET && g_cfg.charset > 0) {
        iCharSet = g_cfg.charset;
    }
    if (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0') {
        if (RewriteFaceNameA(faceBuf, LF_FACESIZE)) {
            pszFaceName = faceBuf;
        }
    }
    return orig_CreateFontA(
        cHeight, cWidth, cEscapement, cOrientation, cWeight,
        bItalic, bUnderline, bStrikeOut, iCharSet,
        iOutPrecision, iClipPrecision, iQuality, iPitchAndFamily, pszFaceName);
}

static HFONT WINAPI Hook_CreateFontW(
    int cHeight, int cWidth, int cEscapement, int cOrientation, int cWeight,
    DWORD bItalic, DWORD bUnderline, DWORD bStrikeOut, DWORD iCharSet,
    DWORD iOutPrecision, DWORD iClipPrecision, DWORD iQuality,
    DWORD iPitchAndFamily, LPCWSTR pszFaceName)
{
    if (iCharSet == SHIFTJIS_CHARSET && g_cfg.charset > 0) {
        iCharSet = g_cfg.charset;
    }
    if (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0') {
        pszFaceName = g_cfg.fontName;
    }
    return orig_CreateFontW(
        cHeight, cWidth, cEscapement, cOrientation, cWeight,
        bItalic, bUnderline, bStrikeOut, iCharSet,
        iOutPrecision, iClipPrecision, iQuality, iPitchAndFamily, pszFaceName);
}

static HFONT WINAPI Hook_CreateFontIndirectA(const LOGFONTA* lplf) {
    LOGFONTA lf;
    if (!lplf) {
        return orig_CreateFontIndirectA(lplf);
    }
    pc_memcpy(&lf, lplf, sizeof(LOGFONTA));
    if ((BYTE)lf.lfCharSet == SHIFTJIS_CHARSET && g_cfg.charset > 0) {
        lf.lfCharSet = (BYTE)g_cfg.charset;
    }
    if (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0') {
        RewriteFaceNameA(lf.lfFaceName, LF_FACESIZE);
    }
    return orig_CreateFontIndirectA(&lf);
}

static HFONT WINAPI Hook_CreateFontIndirectW(const LOGFONTW* lplf) {
    LOGFONTW lf;
    if (!lplf) {
        return orig_CreateFontIndirectW(lplf);
    }
    pc_memcpy(&lf, lplf, sizeof(LOGFONTW));
    if ((BYTE)lf.lfCharSet == SHIFTJIS_CHARSET && g_cfg.charset > 0) {
        lf.lfCharSet = (BYTE)g_cfg.charset;
    }
    if (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0') {
        pc_wcscpy_cap(lf.lfFaceName, LF_FACESIZE, g_cfg.fontName);
    }
    return orig_CreateFontIndirectW(&lf);
}

static int WINAPI Hook_EnumFontFamiliesExA(
    HDC hdc, LPLOGFONTA lpLogfont, FONTENUMPROCA lpProc, LPARAM lParam, DWORD dwFlags)
{
    LOGFONTA lf;
    if (lpLogfont && (BYTE)lpLogfont->lfCharSet == SHIFTJIS_CHARSET && g_cfg.charset > 0) {
        pc_memcpy(&lf, lpLogfont, sizeof(LOGFONTA));
        lf.lfCharSet = (BYTE)g_cfg.charset;
        lpLogfont = &lf;
    }
    return orig_EnumFontFamiliesExA(hdc, lpLogfont, lpProc, lParam, dwFlags);
}

static int WINAPI Hook_EnumFontFamiliesExW(
    HDC hdc, LPLOGFONTW lpLogfont, FONTENUMPROCW lpProc, LPARAM lParam, DWORD dwFlags)
{
    LOGFONTW lf;
    if (lpLogfont && (BYTE)lpLogfont->lfCharSet == SHIFTJIS_CHARSET && g_cfg.charset > 0) {
        pc_memcpy(&lf, lpLogfont, sizeof(LOGFONTW));
        lf.lfCharSet = (BYTE)g_cfg.charset;
        lpLogfont = &lf;
    }
    return orig_EnumFontFamiliesExW(hdc, lpLogfont, lpProc, lParam, dwFlags);
}

static int WINAPI Hook_EnumFontFamiliesA(
    HDC hdc, LPCSTR lpLogfont, FONTENUMPROCA lpProc, LPARAM lParam)
{
    char faceBuf[LF_FACESIZE];
    if (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0' && lpLogfont && lpLogfont[0] != '\0') {
        if (RewriteFaceNameA(faceBuf, LF_FACESIZE)) {
            lpLogfont = faceBuf;
        }
    }
    return orig_EnumFontFamiliesA(hdc, lpLogfont, lpProc, lParam);
}

static int WINAPI Hook_EnumFontFamiliesW(
    HDC hdc, LPCWSTR lpLogfont, FONTENUMPROCW lpProc, LPARAM lParam)
{
    if (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0' && lpLogfont && lpLogfont[0] != L'\0') {
        lpLogfont = g_cfg.fontName;
    }
    return orig_EnumFontFamiliesW(hdc, lpLogfont, lpProc, lParam);
}

/* USER32 wrappers */

static LPSTR WINAPI Hook_CharNextExA(WORD CodePage, LPCSTR lpCurrentChar, DWORD dwFlags) {
    WORD mappedCp = CodePage;
    if (g_cfg.codepage > 0 && (CodePage == 0 || CodePage == 932)) {
        mappedCp = (WORD)g_cfg.codepage;
    }
    return orig_CharNextExA(mappedCp, lpCurrentChar, dwFlags);
}

/* --- IAT Hook Table & PE32 / PE32+ Walker --- */

typedef struct HookEntry {
    const char* dllName;
    const char* funcName;
    void* origPtr;
    void* hookPtr;
    BOOL enabled;
} HookEntry;

static UINT InstallIatHooksForModule(HMODULE mod, const HookEntry* entries, size_t entryCount) {
    BYTE* base;
    IMAGE_DOS_HEADER* dos;
    IMAGE_NT_HEADERS* nt;
    IMAGE_DATA_DIRECTORY importDir;
    IMAGE_IMPORT_DESCRIPTOR* desc;
    UINT count = 0;

    if (!mod) return 0;
    base = (BYTE*)mod;
    dos = (IMAGE_DOS_HEADER*)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    if (dos->e_lfanew <= 0 || dos->e_lfanew >= 0x100000) return 0;

    nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;

    pc_memset(&importDir, 0, sizeof(importDir));
    if (nt->OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR32_MAGIC) {
        IMAGE_NT_HEADERS32* nt32 = (IMAGE_NT_HEADERS32*)nt;
        if (nt32->OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_IMPORT) return 0;
        importDir = nt32->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    } else if (nt->OptionalHeader.Magic == IMAGE_NT_OPTIONAL_HDR64_MAGIC) {
        IMAGE_NT_HEADERS64* nt64 = (IMAGE_NT_HEADERS64*)nt;
        if (nt64->OptionalHeader.NumberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_IMPORT) return 0;
        importDir = nt64->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    } else {
        return 0;
    }

    if (importDir.VirtualAddress == 0 || importDir.Size == 0) return 0;
    desc = (IMAGE_IMPORT_DESCRIPTOR*)(base + importDir.VirtualAddress);

    while (desc->Name != 0 && desc->FirstThunk != 0) {
        const char* impDll = (const char*)(base + desc->Name);
        IMAGE_THUNK_DATA* origThunk = desc->OriginalFirstThunk
            ? (IMAGE_THUNK_DATA*)(base + desc->OriginalFirstThunk)
            : NULL;
        IMAGE_THUNK_DATA* iatThunk = (IMAGE_THUNK_DATA*)(base + desc->FirstThunk);
        size_t i;
        BOOL dllRelevant = FALSE;

        for (i = 0; i < entryCount; ++i) {
            if (entries[i].enabled && pc_ascii_icmp(impDll, entries[i].dllName) == 0) {
                dllRelevant = TRUE;
                break;
            }
        }

        if (dllRelevant) {
            while (iatThunk->u1.Function != 0) {
                const char* impFuncName = NULL;
                if (origThunk && origThunk->u1.AddressOfData != 0 && !IMAGE_SNAP_BY_ORDINAL(origThunk->u1.Ordinal)) {
                    IMAGE_IMPORT_BY_NAME* ibn = (IMAGE_IMPORT_BY_NAME*)(base + origThunk->u1.AddressOfData);
                    impFuncName = (const char*)ibn->Name;
                }

                for (i = 0; i < entryCount; ++i) {
                    const HookEntry* he = &entries[i];
                    BOOL match = FALSE;
                    if (!he->enabled || !he->hookPtr) continue;
                    if (pc_ascii_icmp(impDll, he->dllName) != 0) continue;

                    if (impFuncName && pc_ascii_icmp(impFuncName, he->funcName) == 0) {
                        match = TRUE;
                    } else if (he->origPtr && (ULONG_PTR)iatThunk->u1.Function == (ULONG_PTR)he->origPtr) {
                        match = TRUE;
                    }

                    if (match && (ULONG_PTR)iatThunk->u1.Function != (ULONG_PTR)he->hookPtr) {
                        DWORD oldProt = 0;
                        DWORD tmpProt = 0;
                        if (VirtualProtect(&iatThunk->u1.Function, sizeof(ULONG_PTR), PAGE_READWRITE, &oldProt)) {
                            iatThunk->u1.Function = (ULONG_PTR)he->hookPtr;
                            VirtualProtect(&iatThunk->u1.Function, sizeof(ULONG_PTR), oldProt, &tmpProt);
                            ++count;
                        }
                        break;
                    }
                }

                ++iatThunk;
                if (origThunk) ++origThunk;
            }
        }

        ++desc;
    }

    return count;
}

static HMODULE ResolveSystemModule(const WCHAR* name) {
    HMODULE h = GetModuleHandleW(name);
    if (!h) {
        h = LoadLibraryW(name);
    }
    return h;
}

static void WriteProxyLog(const WCHAR* dllDir, const WCHAR* rawLogPath, const char* proxyName, UINT hookCount) {
    WCHAR resolvedLog[520];
    HANDLE hFile;
    char line[256];
    size_t pos = 0;
    DWORD written = 0;

    if (!rawLogPath || rawLogPath[0] == L'\0') return;
    if (pc_is_abs_path(rawLogPath)) {
        pc_wcscpy_cap(resolvedLog, PC_ARRAY_LEN(resolvedLog), rawLogPath);
    } else if (!pc_join_path(resolvedLog, PC_ARRAY_LEN(resolvedLog), dllDir, rawLogPath)) {
        return;
    }

    hFile = CreateFileW(
        resolvedLog,
        FILE_APPEND_DATA,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        NULL,
        OPEN_ALWAYS,
        FILE_ATTRIBUTE_NORMAL,
        NULL);
    if (hFile == INVALID_HANDLE_VALUE) return;

    line[0] = '\0';
    pos = pc_append_str(line, sizeof(line), pos, "[papercup-proxy] loaded arch=");
#if defined(_WIN64) || defined(__x86_64__)
    pos = pc_append_str(line, sizeof(line), pos, "x64");
#else
    pos = pc_append_str(line, sizeof(line), pos, "x86");
#endif
    pos = pc_append_str(line, sizeof(line), pos, " proxy=");
    pos = pc_append_str(line, sizeof(line), pos, proxyName ? proxyName : "unknown");
    pos = pc_append_str(line, sizeof(line), pos, " codepage=");
    pos = pc_append_u32(line, sizeof(line), pos, g_cfg.codepage);
    pos = pc_append_str(line, sizeof(line), pos, " charset=");
    pos = pc_append_u32(line, sizeof(line), pos, g_cfg.charset);
    pos = pc_append_str(line, sizeof(line), pos, " hooks=");
    pos = pc_append_u32(line, sizeof(line), pos, hookCount);
    pos = pc_append_str(line, sizeof(line), pos, "\r\n");

    WriteFile(hFile, line, (DWORD)pos, &written, NULL);
    CloseHandle(hFile);
}

/* --- Public Entry Points --- */

HMODULE ProxyLoadSystemDll(const WCHAR* dllFileName) {
    WCHAR sysDir[360];
    WCHAR fullPath[520];
    UINT n;

    if (!dllFileName || dllFileName[0] == L'\0') return NULL;
    n = GetSystemDirectoryW(sysDir, (UINT)PC_ARRAY_LEN(sysDir));
    if (n == 0 || n >= PC_ARRAY_LEN(sysDir)) return NULL;
    if (!pc_join_path(fullPath, PC_ARRAY_LEN(fullPath), sysDir, dllFileName)) return NULL;
    return LoadLibraryW(fullPath);
}

void ProxyCoreInit(HMODULE selfModule, const char* proxyName) {
    HMODULE hKernel32;
    HMODULE hGdi32;
    HMODULE hUser32;
    HMODULE hMainExe;
    BOOL hasIni = FALSE;
    BOOL hookCp;
    BOOL hookWidth;
    BOOL hookGdi;
    UINT hookCount = 0;

    if (InterlockedCompareExchange(&g_initState, 1, 0) != 0) {
        return;
    }

    pc_memset(&g_cfg, 0, sizeof(g_cfg));
    pc_memset(&g_scratch, 0, sizeof(g_scratch));
    g_cfg.codepage = 936;
    g_cfg.charset = GB2312_CHARSET;
    g_cfg.enableWidthCompat = TRUE;

    if (GetModuleFileNameW(selfModule, g_scratch.dllPath, (DWORD)PC_ARRAY_LEN(g_scratch.dllPath)) == 0) {
        InterlockedExchange(&g_initState, 2);
        return;
    }
    pc_extract_dir(g_scratch.dllPath, g_scratch.dllDir, PC_ARRAY_LEN(g_scratch.dllDir));

    if (pc_join_path(g_scratch.iniPath, PC_ARRAY_LEN(g_scratch.iniPath), g_scratch.dllDir, L"papercup_patch.ini") &&
        pc_is_regular_file(g_scratch.iniPath))
    {
        hasIni = TRUE;
    } else {
        pc_extract_dir(g_scratch.dllDir, g_scratch.parentDir, PC_ARRAY_LEN(g_scratch.parentDir));
        if (g_scratch.parentDir[0] != L'\0' &&
            pc_join_path(g_scratch.iniPath, PC_ARRAY_LEN(g_scratch.iniPath), g_scratch.parentDir, L"papercup_patch.ini") &&
            pc_is_regular_file(g_scratch.iniPath))
        {
            hasIni = TRUE;
        }
    }

    if (!hasIni) {
        InterlockedExchange(&g_initState, 2);
        return;
    }

    g_cfg.codepage = GetPrivateProfileIntW(L"patch", L"codepage", 936, g_scratch.iniPath);
    g_cfg.charset = GetPrivateProfileIntW(L"patch", L"charset", GB2312_CHARSET, g_scratch.iniPath);
    GetPrivateProfileStringW(L"patch", L"font_name", L"", g_cfg.fontName, LF_FACESIZE, g_scratch.iniPath);
    g_cfg.forceFontName = GetPrivateProfileIntW(L"patch", L"force_font_name", 0, g_scratch.iniPath) != 0;
    g_cfg.enableWidthCompat = GetPrivateProfileIntW(L"patch", L"enable_width_compat", 1, g_scratch.iniPath) != 0;
    GetPrivateProfileStringW(L"patch", L"log_file", L"", g_scratch.logPath, (DWORD)PC_ARRAY_LEN(g_scratch.logPath), g_scratch.iniPath);

    hookCp = (g_cfg.codepage > 0);
    hookWidth = (g_cfg.codepage > 0 && g_cfg.enableWidthCompat);
    hookGdi = (g_cfg.charset > 0 || (g_cfg.forceFontName && g_cfg.fontName[0] != L'\0'));

    if (!hookCp && !hookGdi) {
        WriteProxyLog(g_scratch.dllDir, g_scratch.logPath, proxyName, 0);
        InterlockedExchange(&g_initState, 2);
        return;
    }

    /* Resolve all original Win32 API pointers BEFORE installing any IAT hooks. */
    hKernel32 = GetModuleHandleW(L"kernel32.dll");
    hGdi32 = hookGdi ? ResolveSystemModule(L"gdi32.dll") : NULL;
    hUser32 = hookWidth ? ResolveSystemModule(L"user32.dll") : NULL;

    if (hKernel32) {
        orig_GetACP              = (PFN_GetACP)(ULONG_PTR)GetProcAddress(hKernel32, "GetACP");
        orig_GetOEMCP            = (PFN_GetOEMCP)(ULONG_PTR)GetProcAddress(hKernel32, "GetOEMCP");
        orig_GetCPInfo           = (PFN_GetCPInfo)(ULONG_PTR)GetProcAddress(hKernel32, "GetCPInfo");
        orig_GetCPInfoExA        = (PFN_GetCPInfoExA)(ULONG_PTR)GetProcAddress(hKernel32, "GetCPInfoExA");
        orig_GetCPInfoExW        = (PFN_GetCPInfoExW)(ULONG_PTR)GetProcAddress(hKernel32, "GetCPInfoExW");
        orig_MultiByteToWideChar = (PFN_MultiByteToWideChar)(ULONG_PTR)GetProcAddress(hKernel32, "MultiByteToWideChar");
        orig_WideCharToMultiByte = (PFN_WideCharToMultiByte)(ULONG_PTR)GetProcAddress(hKernel32, "WideCharToMultiByte");
        orig_IsDBCSLeadByte      = (PFN_IsDBCSLeadByte)(ULONG_PTR)GetProcAddress(hKernel32, "IsDBCSLeadByte");
        orig_IsDBCSLeadByteEx    = (PFN_IsDBCSLeadByteEx)(ULONG_PTR)GetProcAddress(hKernel32, "IsDBCSLeadByteEx");
    }

    if (hGdi32) {
        orig_CreateFontA         = (PFN_CreateFontA)(ULONG_PTR)GetProcAddress(hGdi32, "CreateFontA");
        orig_CreateFontW         = (PFN_CreateFontW)(ULONG_PTR)GetProcAddress(hGdi32, "CreateFontW");
        orig_CreateFontIndirectA = (PFN_CreateFontIndirectA)(ULONG_PTR)GetProcAddress(hGdi32, "CreateFontIndirectA");
        orig_CreateFontIndirectW = (PFN_CreateFontIndirectW)(ULONG_PTR)GetProcAddress(hGdi32, "CreateFontIndirectW");
        orig_EnumFontFamiliesExA = (PFN_EnumFontFamiliesExA)(ULONG_PTR)GetProcAddress(hGdi32, "EnumFontFamiliesExA");
        orig_EnumFontFamiliesExW = (PFN_EnumFontFamiliesExW)(ULONG_PTR)GetProcAddress(hGdi32, "EnumFontFamiliesExW");
        orig_EnumFontFamiliesA   = (PFN_EnumFontFamiliesA)(ULONG_PTR)GetProcAddress(hGdi32, "EnumFontFamiliesA");
        orig_EnumFontFamiliesW   = (PFN_EnumFontFamiliesW)(ULONG_PTR)GetProcAddress(hGdi32, "EnumFontFamiliesW");
    }

    if (hUser32) {
        orig_CharNextExA = (PFN_CharNextExA)(ULONG_PTR)GetProcAddress(hUser32, "CharNextExA");
    }

    {
        HookEntry hooks[18];
        size_t nHooks = 0;

        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "GetACP",              (void*)(ULONG_PTR)orig_GetACP,              (void*)(ULONG_PTR)Hook_GetACP,              hookCp && orig_GetACP != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "GetOEMCP",            (void*)(ULONG_PTR)orig_GetOEMCP,            (void*)(ULONG_PTR)Hook_GetOEMCP,            hookCp && orig_GetOEMCP != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "GetCPInfo",           (void*)(ULONG_PTR)orig_GetCPInfo,           (void*)(ULONG_PTR)Hook_GetCPInfo,           hookCp && orig_GetCPInfo != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "GetCPInfoExA",        (void*)(ULONG_PTR)orig_GetCPInfoExA,        (void*)(ULONG_PTR)Hook_GetCPInfoExA,        hookCp && orig_GetCPInfoExA != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "GetCPInfoExW",        (void*)(ULONG_PTR)orig_GetCPInfoExW,        (void*)(ULONG_PTR)Hook_GetCPInfoExW,        hookCp && orig_GetCPInfoExW != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "MultiByteToWideChar", (void*)(ULONG_PTR)orig_MultiByteToWideChar, (void*)(ULONG_PTR)Hook_MultiByteToWideChar, hookWidth && orig_MultiByteToWideChar != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "WideCharToMultiByte", (void*)(ULONG_PTR)orig_WideCharToMultiByte, (void*)(ULONG_PTR)Hook_WideCharToMultiByte, hookWidth && orig_WideCharToMultiByte != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "IsDBCSLeadByte",      (void*)(ULONG_PTR)orig_IsDBCSLeadByte,      (void*)(ULONG_PTR)Hook_IsDBCSLeadByte,      hookWidth && orig_IsDBCSLeadByte != NULL };
        hooks[nHooks++] = (HookEntry){ "kernel32.dll", "IsDBCSLeadByteEx",    (void*)(ULONG_PTR)orig_IsDBCSLeadByteEx,    (void*)(ULONG_PTR)Hook_IsDBCSLeadByteEx,    hookWidth && orig_IsDBCSLeadByteEx != NULL };

        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "CreateFontA",         (void*)(ULONG_PTR)orig_CreateFontA,         (void*)(ULONG_PTR)Hook_CreateFontA,         hookGdi && orig_CreateFontA != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "CreateFontW",         (void*)(ULONG_PTR)orig_CreateFontW,         (void*)(ULONG_PTR)Hook_CreateFontW,         hookGdi && orig_CreateFontW != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "CreateFontIndirectA", (void*)(ULONG_PTR)orig_CreateFontIndirectA, (void*)(ULONG_PTR)Hook_CreateFontIndirectA, hookGdi && orig_CreateFontIndirectA != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "CreateFontIndirectW", (void*)(ULONG_PTR)orig_CreateFontIndirectW, (void*)(ULONG_PTR)Hook_CreateFontIndirectW, hookGdi && orig_CreateFontIndirectW != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "EnumFontFamiliesExA", (void*)(ULONG_PTR)orig_EnumFontFamiliesExA, (void*)(ULONG_PTR)Hook_EnumFontFamiliesExA, hookGdi && orig_EnumFontFamiliesExA != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "EnumFontFamiliesExW", (void*)(ULONG_PTR)orig_EnumFontFamiliesExW, (void*)(ULONG_PTR)Hook_EnumFontFamiliesExW, hookGdi && orig_EnumFontFamiliesExW != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "EnumFontFamiliesA",   (void*)(ULONG_PTR)orig_EnumFontFamiliesA,   (void*)(ULONG_PTR)Hook_EnumFontFamiliesA,   hookGdi && orig_EnumFontFamiliesA != NULL };
        hooks[nHooks++] = (HookEntry){ "gdi32.dll", "EnumFontFamiliesW",   (void*)(ULONG_PTR)orig_EnumFontFamiliesW,   (void*)(ULONG_PTR)Hook_EnumFontFamiliesW,   hookGdi && orig_EnumFontFamiliesW != NULL };

        hooks[nHooks++] = (HookEntry){ "user32.dll", "CharNextExA", (void*)(ULONG_PTR)orig_CharNextExA, (void*)(ULONG_PTR)Hook_CharNextExA, hookWidth && orig_CharNextExA != NULL };

        hMainExe = GetModuleHandleW(NULL);
        if (hMainExe && GetModuleFileNameW(hMainExe, g_scratch.mainExePath, (DWORD)PC_ARRAY_LEN(g_scratch.mainExePath)) > 0) {
            pc_extract_dir(g_scratch.mainExePath, g_scratch.mainExeDir, PC_ARRAY_LEN(g_scratch.mainExeDir));
        }

        if (GetWindowsDirectoryW(g_scratch.winDir, (UINT)PC_ARRAY_LEN(g_scratch.winDir)) >= PC_ARRAY_LEN(g_scratch.winDir)) {
            g_scratch.winDir[0] = L'\0';
        }

        if (hMainExe && hMainExe != selfModule) {
            hookCount += InstallIatHooksForModule(hMainExe, hooks, nHooks);
        }

        {
            HANDLE hSnap = INVALID_HANDLE_VALUE;
            int attempt;
            for (attempt = 0; attempt < 3; ++attempt) {
                hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
                if (hSnap != INVALID_HANDLE_VALUE || GetLastError() != ERROR_BAD_LENGTH) {
                    break;
                }
            }
            if (hSnap != INVALID_HANDLE_VALUE) {
                g_scratch.me.dwSize = sizeof(g_scratch.me);
                if (Module32FirstW(hSnap, &g_scratch.me)) {
                    do {
                        if (!g_scratch.me.hModule || g_scratch.me.hModule == selfModule || g_scratch.me.hModule == hMainExe) {
                            continue;
                        }
                        if (g_scratch.winDir[0] != L'\0' && pc_wcs_istartswith(g_scratch.me.szExePath, g_scratch.winDir)) {
                            continue;
                        }
                        pc_extract_dir(g_scratch.me.szExePath, g_scratch.modDir, PC_ARRAY_LEN(g_scratch.modDir));
                        if (g_scratch.mainExeDir[0] != L'\0' && pc_wcs_ieq(g_scratch.modDir, g_scratch.mainExeDir)) {
                            hookCount += InstallIatHooksForModule(g_scratch.me.hModule, hooks, nHooks);
                        }
                    } while (Module32NextW(hSnap, &g_scratch.me));
                }
                CloseHandle(hSnap);
            }
        }
    }

    WriteProxyLog(g_scratch.dllDir, g_scratch.logPath, proxyName, hookCount);
    InterlockedExchange(&g_initState, 2);
}
