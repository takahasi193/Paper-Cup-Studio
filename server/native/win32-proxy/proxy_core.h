#ifndef PAPERCUP_PROXY_CORE_H
#define PAPERCUP_PROXY_CORE_H

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Initialize configuration, resolve target Win32 APIs, install IAT hooks, and write optional log line. */
void ProxyCoreInit(HMODULE selfModule, const char* proxyName);

/* Load a real Windows system DLL from GetSystemDirectoryW() + "\\" + dllFileName. */
HMODULE ProxyLoadSystemDll(const WCHAR* dllFileName);

#ifdef __cplusplus
}
#endif

#endif /* PAPERCUP_PROXY_CORE_H */
