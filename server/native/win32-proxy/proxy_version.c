#include "proxy_core.h"

static HMODULE g_realVersion = NULL;

static FARPROC ResolveRealVersionProc(const char* name) {
    if (!g_realVersion) {
        g_realVersion = ProxyLoadSystemDll(L"version.dll");
    }
    return g_realVersion ? GetProcAddress(g_realVersion, name) : NULL;
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)lpvReserved;
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        g_realVersion = ProxyLoadSystemDll(L"version.dll");
        ProxyCoreInit(hinstDLL, "version.dll");
    } else if (fdwReason == DLL_PROCESS_DETACH) {
        if (g_realVersion) {
            FreeLibrary(g_realVersion);
            g_realVersion = NULL;
        }
    }
    return TRUE;
}

#define FORWARD_VER(retType, name, failRet, protoArgs, callArgs) \
    typedef retType (WINAPI *PFN_##name) protoArgs;              \
    retType WINAPI name protoArgs {                              \
        static PFN_##name fn = NULL;                             \
        if (!fn) fn = (PFN_##name)(ULONG_PTR)ResolveRealVersionProc(#name); \
        return fn ? fn callArgs : (failRet);                     \
    }

FORWARD_VER(BOOL, GetFileVersionInfoA, FALSE,
    (LPCSTR lptstrFilename, DWORD dwHandle, DWORD dwLen, LPVOID lpData),
    (lptstrFilename, dwHandle, dwLen, lpData))

FORWARD_VER(BOOL, GetFileVersionInfoW, FALSE,
    (LPCWSTR lptstrFilename, DWORD dwHandle, DWORD dwLen, LPVOID lpData),
    (lptstrFilename, dwHandle, dwLen, lpData))

FORWARD_VER(BOOL, GetFileVersionInfoByHandle, FALSE,
    (DWORD dwFlags, HANDLE hFile, LPVOID* lplpData, LPDWORD pdwLen),
    (dwFlags, hFile, lplpData, pdwLen))

FORWARD_VER(BOOL, GetFileVersionInfoExA, FALSE,
    (DWORD dwFlags, LPCSTR lpwstrFilename, DWORD dwHandle, DWORD dwLen, LPVOID lpData),
    (dwFlags, lpwstrFilename, dwHandle, dwLen, lpData))

FORWARD_VER(BOOL, GetFileVersionInfoExW, FALSE,
    (DWORD dwFlags, LPCWSTR lpwstrFilename, DWORD dwHandle, DWORD dwLen, LPVOID lpData),
    (dwFlags, lpwstrFilename, dwHandle, dwLen, lpData))

FORWARD_VER(DWORD, GetFileVersionInfoSizeA, 0,
    (LPCSTR lptstrFilename, LPDWORD lpdwHandle),
    (lptstrFilename, lpdwHandle))

FORWARD_VER(DWORD, GetFileVersionInfoSizeW, 0,
    (LPCWSTR lptstrFilename, LPDWORD lpdwHandle),
    (lptstrFilename, lpdwHandle))

FORWARD_VER(DWORD, GetFileVersionInfoSizeExA, 0,
    (DWORD dwFlags, LPCSTR lpwstrFilename, LPDWORD lpdwHandle),
    (dwFlags, lpwstrFilename, lpdwHandle))

FORWARD_VER(DWORD, GetFileVersionInfoSizeExW, 0,
    (DWORD dwFlags, LPCWSTR lpwstrFilename, LPDWORD lpdwHandle),
    (dwFlags, lpwstrFilename, lpdwHandle))

FORWARD_VER(DWORD, VerFindFileA, 0,
    (DWORD uFlags, LPSTR szFileName, LPSTR szWinDir, LPSTR szAppDir, LPSTR szCurDir, PUINT lpuCurDirLen, LPSTR szDestDir, PUINT lpuDestDirLen),
    (uFlags, szFileName, szWinDir, szAppDir, szCurDir, lpuCurDirLen, szDestDir, lpuDestDirLen))

FORWARD_VER(DWORD, VerFindFileW, 0,
    (DWORD uFlags, LPWSTR szFileName, LPWSTR szWinDir, LPWSTR szAppDir, LPWSTR szCurDir, PUINT lpuCurDirLen, LPWSTR szDestDir, PUINT lpuDestDirLen),
    (uFlags, szFileName, szWinDir, szAppDir, szCurDir, lpuCurDirLen, szDestDir, lpuDestDirLen))

FORWARD_VER(DWORD, VerInstallFileA, 0,
    (DWORD uFlags, LPSTR szSrcFileName, LPSTR szDestFileName, LPSTR szSrcDir, LPSTR szDestDir, LPSTR szCurDir, LPSTR szTmpFile, PUINT lpuTmpFileLen),
    (uFlags, szSrcFileName, szDestFileName, szSrcDir, szDestDir, szCurDir, szTmpFile, lpuTmpFileLen))

FORWARD_VER(DWORD, VerInstallFileW, 0,
    (DWORD uFlags, LPWSTR szSrcFileName, LPWSTR szDestFileName, LPWSTR szSrcDir, LPWSTR szDestDir, LPWSTR szCurDir, LPWSTR szTmpFile, PUINT lpuTmpFileLen),
    (uFlags, szSrcFileName, szDestFileName, szSrcDir, szDestDir, szCurDir, szTmpFile, lpuTmpFileLen))

FORWARD_VER(DWORD, VerLanguageNameA, 0,
    (DWORD wLang, LPSTR szLang, DWORD nSize),
    (wLang, szLang, nSize))

FORWARD_VER(DWORD, VerLanguageNameW, 0,
    (DWORD wLang, LPWSTR szLang, DWORD nSize),
    (wLang, szLang, nSize))

FORWARD_VER(BOOL, VerQueryValueA, FALSE,
    (LPCVOID pBlock, LPCSTR lpSubBlock, LPVOID* lplpBuffer, PUINT puLen),
    (pBlock, lpSubBlock, lplpBuffer, puLen))

FORWARD_VER(BOOL, VerQueryValueW, FALSE,
    (LPCVOID pBlock, LPCWSTR lpSubBlock, LPVOID* lplpBuffer, PUINT puLen),
    (pBlock, lpSubBlock, lplpBuffer, puLen))
