#include "proxy_core.h"

typedef UINT MMRESULT;
typedef DWORD MCIERROR;
typedef UINT MCIDEVICEID;
typedef DWORD FOURCC;

static HMODULE g_realWinmm = NULL;

static FARPROC ResolveRealWinmmProc(const char* name) {
    if (!g_realWinmm) {
        g_realWinmm = ProxyLoadSystemDll(L"winmm.dll");
    }
    return g_realWinmm ? GetProcAddress(g_realWinmm, name) : NULL;
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    (void)lpvReserved;
    if (fdwReason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinstDLL);
        g_realWinmm = ProxyLoadSystemDll(L"winmm.dll");
        ProxyCoreInit(hinstDLL, "winmm.dll");
    } else if (fdwReason == DLL_PROCESS_DETACH) {
        if (g_realWinmm) {
            FreeLibrary(g_realWinmm);
            g_realWinmm = NULL;
        }
    }
    return TRUE;
}

#define FORWARD_WINMM(retType, name, failRet, protoArgs, callArgs) \
    typedef retType (WINAPI *PFN_##name) protoArgs;                \
    retType WINAPI name protoArgs {                                \
        static PFN_##name fn = NULL;                               \
        if (!fn) fn = (PFN_##name)(ULONG_PTR)ResolveRealWinmmProc(#name); \
        return fn ? fn callArgs : (failRet);                       \
    }

/* Timer APIs */
FORWARD_WINMM(DWORD, timeGetTime, 0, (void), ())
FORWARD_WINMM(MMRESULT, timeBeginPeriod, 0, (UINT uPeriod), (uPeriod))
FORWARD_WINMM(MMRESULT, timeEndPeriod, 0, (UINT uPeriod), (uPeriod))
FORWARD_WINMM(MMRESULT, timeGetDevCaps, 0, (LPVOID ptc, UINT cbtc), (ptc, cbtc))
FORWARD_WINMM(MMRESULT, timeGetSystemTime, 0, (LPVOID pmmt, UINT cbmmt), (pmmt, cbmmt))
FORWARD_WINMM(MMRESULT, timeSetEvent, 0, (UINT uDelay, UINT uResolution, LPVOID fptc, DWORD_PTR dwUser, UINT fuEvent), (uDelay, uResolution, fptc, dwUser, fuEvent))
FORWARD_WINMM(MMRESULT, timeKillEvent, 0, (UINT uTimerID), (uTimerID))

/* PlaySound APIs */
FORWARD_WINMM(BOOL, PlaySound, FALSE, (LPCSTR pszSound, HMODULE hmod, DWORD fdwSound), (pszSound, hmod, fdwSound))
FORWARD_WINMM(BOOL, PlaySoundA, FALSE, (LPCSTR pszSound, HMODULE hmod, DWORD fdwSound), (pszSound, hmod, fdwSound))
FORWARD_WINMM(BOOL, PlaySoundW, FALSE, (LPCWSTR pszSound, HMODULE hmod, DWORD fdwSound), (pszSound, hmod, fdwSound))
FORWARD_WINMM(BOOL, sndPlaySoundA, FALSE, (LPCSTR pszSound, UINT fuSound), (pszSound, fuSound))
FORWARD_WINMM(BOOL, sndPlaySoundW, FALSE, (LPCWSTR pszSound, UINT fuSound), (pszSound, fuSound))

/* MCI APIs */
FORWARD_WINMM(MCIERROR, mciSendStringA, 0, (LPCSTR lpstrCommand, LPSTR lpstrReturnString, UINT uReturnLength, HWND hwndCallback), (lpstrCommand, lpstrReturnString, uReturnLength, hwndCallback))
FORWARD_WINMM(MCIERROR, mciSendStringW, 0, (LPCWSTR lpstrCommand, LPWSTR lpstrReturnString, UINT uReturnLength, HWND hwndCallback), (lpstrCommand, lpstrReturnString, uReturnLength, hwndCallback))
FORWARD_WINMM(MCIERROR, mciSendCommandA, 0, (MCIDEVICEID mciId, UINT uMsg, DWORD_PTR dwParam1, DWORD_PTR dwParam2), (mciId, uMsg, dwParam1, dwParam2))
FORWARD_WINMM(MCIERROR, mciSendCommandW, 0, (MCIDEVICEID mciId, UINT uMsg, DWORD_PTR dwParam1, DWORD_PTR dwParam2), (mciId, uMsg, dwParam1, dwParam2))
FORWARD_WINMM(BOOL, mciGetErrorStringA, FALSE, (MCIERROR mcierr, LPSTR pszText, UINT cchText), (mcierr, pszText, cchText))
FORWARD_WINMM(BOOL, mciGetErrorStringW, FALSE, (MCIERROR mcierr, LPWSTR pszText, UINT cchText), (mcierr, pszText, cchText))
FORWARD_WINMM(MCIDEVICEID, mciGetDeviceIDA, 0, (LPCSTR pszDevice), (pszDevice))
FORWARD_WINMM(MCIDEVICEID, mciGetDeviceIDW, 0, (LPCWSTR pszDevice), (pszDevice))

/* MMIO APIs */
FORWARD_WINMM(HANDLE, mmioOpenA, NULL, (LPSTR pszFileName, LPVOID pmmioinfo, DWORD fdwOpen), (pszFileName, pmmioinfo, fdwOpen))
FORWARD_WINMM(HANDLE, mmioOpenW, NULL, (LPWSTR pszFileName, LPVOID pmmioinfo, DWORD fdwOpen), (pszFileName, pmmioinfo, fdwOpen))
FORWARD_WINMM(MMRESULT, mmioClose, 0, (HANDLE hmmio, UINT fuClose), (hmmio, fuClose))
FORWARD_WINMM(LONG, mmioRead, -1, (HANDLE hmmio, LPSTR pch, LONG cch), (hmmio, pch, cch))
FORWARD_WINMM(LONG, mmioWrite, -1, (HANDLE hmmio, LPCSTR pch, LONG cch), (hmmio, pch, cch))
FORWARD_WINMM(LONG, mmioSeek, -1, (HANDLE hmmio, LONG lOffset, int iOrigin), (hmmio, lOffset, iOrigin))
FORWARD_WINMM(MMRESULT, mmioDescend, 0, (HANDLE hmmio, LPVOID pmmcki, LPCVOID pmmckiParent, UINT fuDescend), (hmmio, pmmcki, pmmckiParent, fuDescend))
FORWARD_WINMM(MMRESULT, mmioAscend, 0, (HANDLE hmmio, LPVOID pmmcki, UINT fuAscend), (hmmio, pmmcki, fuAscend))
FORWARD_WINMM(MMRESULT, mmioCreateChunk, 0, (HANDLE hmmio, LPVOID pmmcki, UINT fuCreate), (hmmio, pmmcki, fuCreate))
FORWARD_WINMM(MMRESULT, mmioGetInfo, 0, (HANDLE hmmio, LPVOID pmmioinfo, UINT fuInfo), (hmmio, pmmioinfo, fuInfo))
FORWARD_WINMM(MMRESULT, mmioSetInfo, 0, (HANDLE hmmio, LPCVOID pmmioinfo, UINT fuInfo), (hmmio, pmmioinfo, fuInfo))
FORWARD_WINMM(MMRESULT, mmioAdvance, 0, (HANDLE hmmio, LPVOID pmmioinfo, UINT fuAdvance), (hmmio, pmmioinfo, fuAdvance))
FORWARD_WINMM(MMRESULT, mmioFlush, 0, (HANDLE hmmio, UINT fuFlush), (hmmio, fuFlush))
FORWARD_WINMM(MMRESULT, mmioSetBuffer, 0, (HANDLE hmmio, LPSTR pchBuffer, LONG cchBuffer, UINT fuBuffer), (hmmio, pchBuffer, cchBuffer, fuBuffer))
FORWARD_WINMM(LPVOID, mmioInstallIOProcA, NULL, (FOURCC fccIOProc, LPVOID pIOProc, DWORD dwFlags), (fccIOProc, pIOProc, dwFlags))
FORWARD_WINMM(LPVOID, mmioInstallIOProcW, NULL, (FOURCC fccIOProc, LPVOID pIOProc, DWORD dwFlags), (fccIOProc, pIOProc, dwFlags))
FORWARD_WINMM(FOURCC, mmioStringToFOURCCA, 0, (LPCSTR sz, UINT uFlags), (sz, uFlags))
FORWARD_WINMM(FOURCC, mmioStringToFOURCCW, 0, (LPCWSTR sz, UINT uFlags), (sz, uFlags))

/* WaveOut APIs */
FORWARD_WINMM(MMRESULT, waveOutOpen, 0, (LPVOID phwo, UINT uDeviceID, LPCVOID pwfx, DWORD_PTR dwCallback, DWORD_PTR dwInstance, DWORD fdwOpen), (phwo, uDeviceID, pwfx, dwCallback, dwInstance, fdwOpen))
FORWARD_WINMM(MMRESULT, waveOutClose, 0, (HANDLE hwo), (hwo))
FORWARD_WINMM(MMRESULT, waveOutPrepareHeader, 0, (HANDLE hwo, LPVOID pwh, UINT cbwh), (hwo, pwh, cbwh))
FORWARD_WINMM(MMRESULT, waveOutUnprepareHeader, 0, (HANDLE hwo, LPVOID pwh, UINT cbwh), (hwo, pwh, cbwh))
FORWARD_WINMM(MMRESULT, waveOutWrite, 0, (HANDLE hwo, LPVOID pwh, UINT cbwh), (hwo, pwh, cbwh))
FORWARD_WINMM(MMRESULT, waveOutReset, 0, (HANDLE hwo), (hwo))
FORWARD_WINMM(MMRESULT, waveOutPause, 0, (HANDLE hwo), (hwo))
FORWARD_WINMM(MMRESULT, waveOutRestart, 0, (HANDLE hwo), (hwo))
FORWARD_WINMM(MMRESULT, waveOutSetVolume, 0, (HANDLE hwo, DWORD dwVolume), (hwo, dwVolume))
FORWARD_WINMM(MMRESULT, waveOutGetVolume, 0, (HANDLE hwo, LPDWORD pdwVolume), (hwo, pdwVolume))
FORWARD_WINMM(MMRESULT, waveOutGetPosition, 0, (HANDLE hwo, LPVOID pmmt, UINT cbmmt), (hwo, pmmt, cbmmt))
FORWARD_WINMM(UINT, waveOutGetNumDevs, 0, (void), ())
FORWARD_WINMM(MMRESULT, waveOutGetDevCapsA, 0, (UINT_PTR uDeviceID, LPVOID pwoc, UINT cbwoc), (uDeviceID, pwoc, cbwoc))
FORWARD_WINMM(MMRESULT, waveOutGetDevCapsW, 0, (UINT_PTR uDeviceID, LPVOID pwoc, UINT cbwoc), (uDeviceID, pwoc, cbwoc))
FORWARD_WINMM(MMRESULT, waveOutGetErrorTextA, 0, (MMRESULT mmrError, LPSTR pszText, UINT cchText), (mmrError, pszText, cchText))
FORWARD_WINMM(MMRESULT, waveOutGetErrorTextW, 0, (MMRESULT mmrError, LPWSTR pszText, UINT cchText), (mmrError, pszText, cchText))
FORWARD_WINMM(MMRESULT, waveOutGetID, 0, (HANDLE hwo, PUINT puDeviceID), (hwo, puDeviceID))
FORWARD_WINMM(MMRESULT, waveOutMessage, 0, (HANDLE hwo, UINT uMsg, DWORD_PTR dw1, DWORD_PTR dw2), (hwo, uMsg, dw1, dw2))

/* Joystick / Aux / MIDI APIs */
FORWARD_WINMM(MMRESULT, joyGetPos, 0, (UINT uJoyID, LPVOID pji), (uJoyID, pji))
FORWARD_WINMM(MMRESULT, joyGetPosEx, 0, (UINT uJoyID, LPVOID pji), (uJoyID, pji))
FORWARD_WINMM(MMRESULT, joyGetDevCapsA, 0, (UINT_PTR uJoyID, LPVOID pjc, UINT cbjc), (uJoyID, pjc, cbjc))
FORWARD_WINMM(MMRESULT, joyGetDevCapsW, 0, (UINT_PTR uJoyID, LPVOID pjc, UINT cbjc), (uJoyID, pjc, cbjc))
FORWARD_WINMM(UINT, joyGetNumDevs, 0, (void), ())
FORWARD_WINMM(MMRESULT, joyGetThreshold, 0, (UINT uJoyID, PUINT puThreshold), (uJoyID, puThreshold))
FORWARD_WINMM(MMRESULT, joySetCapture, 0, (HWND hwnd, UINT uJoyID, UINT uPeriod, BOOL fChanged), (hwnd, uJoyID, uPeriod, fChanged))
FORWARD_WINMM(MMRESULT, joyReleaseCapture, 0, (UINT uJoyID), (uJoyID))
FORWARD_WINMM(UINT, auxGetNumDevs, 0, (void), ())
FORWARD_WINMM(MMRESULT, auxGetDevCapsA, 0, (UINT_PTR uDeviceID, LPVOID pac, UINT cbac), (uDeviceID, pac, cbac))
FORWARD_WINMM(MMRESULT, auxGetDevCapsW, 0, (UINT_PTR uDeviceID, LPVOID pac, UINT cbac), (uDeviceID, pac, cbac))
FORWARD_WINMM(UINT, midiOutGetNumDevs, 0, (void), ())
FORWARD_WINMM(MMRESULT, midiOutGetDevCapsA, 0, (UINT_PTR uDeviceID, LPVOID pmoc, UINT cbmoc), (uDeviceID, pmoc, cbmoc))
FORWARD_WINMM(MMRESULT, midiOutGetDevCapsW, 0, (UINT_PTR uDeviceID, LPVOID pmoc, UINT cbmoc), (uDeviceID, pmoc, cbmoc))
FORWARD_WINMM(MMRESULT, midiOutOpen, 0, (LPVOID phmo, UINT uDeviceID, DWORD_PTR dwCallback, DWORD_PTR dwInstance, DWORD fdwOpen), (phmo, uDeviceID, dwCallback, dwInstance, fdwOpen))
FORWARD_WINMM(MMRESULT, midiOutClose, 0, (HANDLE hmo), (hmo))
FORWARD_WINMM(MMRESULT, midiOutShortMsg, 0, (HANDLE hmo, DWORD dwMsg), (hmo, dwMsg))
FORWARD_WINMM(MMRESULT, midiOutLongMsg, 0, (HANDLE hmo, LPVOID pmh, UINT cbmh), (hmo, pmh, cbmh))
FORWARD_WINMM(MMRESULT, midiOutPrepareHeader, 0, (HANDLE hmo, LPVOID pmh, UINT cbmh), (hmo, pmh, cbmh))
FORWARD_WINMM(MMRESULT, midiOutUnprepareHeader, 0, (HANDLE hmo, LPVOID pmh, UINT cbmh), (hmo, pmh, cbmh))
FORWARD_WINMM(MMRESULT, midiOutReset, 0, (HANDLE hmo), (hmo))

/* Mixer APIs */
FORWARD_WINMM(MMRESULT, mixerOpen, 0, (LPVOID phmx, UINT uMxId, DWORD_PTR dwCallback, DWORD_PTR dwInstance, DWORD fdwOpen), (phmx, uMxId, dwCallback, dwInstance, fdwOpen))
FORWARD_WINMM(MMRESULT, mixerClose, 0, (HANDLE hmx), (hmx))
FORWARD_WINMM(MMRESULT, mixerGetControlDetailsA, 0, (HANDLE hmxobj, LPVOID pmxcd, DWORD fdwDetails), (hmxobj, pmxcd, fdwDetails))
FORWARD_WINMM(MMRESULT, mixerGetControlDetailsW, 0, (HANDLE hmxobj, LPVOID pmxcd, DWORD fdwDetails), (hmxobj, pmxcd, fdwDetails))
FORWARD_WINMM(MMRESULT, mixerSetControlDetails, 0, (HANDLE hmxobj, LPVOID pmxcd, DWORD fdwDetails), (hmxobj, pmxcd, fdwDetails))
FORWARD_WINMM(MMRESULT, mixerGetLineInfoA, 0, (HANDLE hmxobj, LPVOID pmxl, DWORD fdwInfo), (hmxobj, pmxl, fdwInfo))
FORWARD_WINMM(MMRESULT, mixerGetLineInfoW, 0, (HANDLE hmxobj, LPVOID pmxl, DWORD fdwInfo), (hmxobj, pmxl, fdwInfo))
FORWARD_WINMM(MMRESULT, mixerGetLineControlsA, 0, (HANDLE hmxobj, LPVOID pmxlc, DWORD fdwControls), (hmxobj, pmxlc, fdwControls))
FORWARD_WINMM(MMRESULT, mixerGetLineControlsW, 0, (HANDLE hmxobj, LPVOID pmxlc, DWORD fdwControls), (hmxobj, pmxlc, fdwControls))
FORWARD_WINMM(UINT, mixerGetNumDevs, 0, (void), ())
FORWARD_WINMM(MMRESULT, mixerGetDevCapsA, 0, (UINT_PTR uMxId, LPVOID pmxcaps, UINT cbmxcaps), (uMxId, pmxcaps, cbmxcaps))
FORWARD_WINMM(MMRESULT, mixerGetDevCapsW, 0, (UINT_PTR uMxId, LPVOID pmxcaps, UINT cbmxcaps), (uMxId, pmxcaps, cbmxcaps))
FORWARD_WINMM(MMRESULT, mixerGetID, 0, (HANDLE hmxobj, PUINT puMxId, DWORD fdwId), (hmxobj, puMxId, fdwId))
FORWARD_WINMM(DWORD, mixerMessage, 0, (HANDLE hmx, UINT uMsg, DWORD_PTR dwParam1, DWORD_PTR dwParam2), (hmx, uMsg, dwParam1, dwParam2))
