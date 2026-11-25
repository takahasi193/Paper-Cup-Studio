import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface FolderPickResult {
  canceled: boolean;
  path: string | null;
}

export type FolderPickerFn = (options?: {
  initialDir?: string;
  title?: string;
}) => Promise<FolderPickResult>;

export type FilePickerFn = (options?: {
  initialPath?: string;
  title?: string;
  filter?: string;
}) => Promise<FolderPickResult>;

const DEFAULT_TITLE = '选择游戏工作区目录';
const DEFAULT_FILE_TITLE = '选择 Ollama 可执行文件';
const DEFAULT_FILE_FILTER = 'Ollama 可执行文件 (ollama.exe)|ollama.exe|可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*';
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

export const WINDOWS_FILE_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

$initDir = $env:PAPERCUP_PICKER_INIT
$dlgTitle = $env:PAPERCUP_PICKER_TITLE
$dlgFilter = $env:PAPERCUP_PICKER_FILTER
if ([string]::IsNullOrWhiteSpace($dlgTitle)) { $dlgTitle = '选择 Ollama 可执行文件' }
if ([string]::IsNullOrWhiteSpace($dlgFilter)) { $dlgFilter = '所有文件 (*.*)|*.*' }

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Opacity = 0

$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = $dlgTitle
$dlg.Filter = $dlgFilter
$dlg.Multiselect = $false
$dlg.CheckFileExists = $true
$dlg.CheckPathExists = $true
$dlg.DereferenceLinks = $true
if (-not [string]::IsNullOrWhiteSpace($initDir) -and (Test-Path -LiteralPath $initDir -PathType Container)) {
  $dlg.InitialDirectory = $initDir
}

try {
  $owner.Show()
  $owner.Activate()
  $res = $dlg.ShowDialog($owner)
  if ($res -eq [System.Windows.Forms.DialogResult]::OK -and -not [string]::IsNullOrWhiteSpace($dlg.FileName)) {
    [Console]::Out.Write($dlg.FileName)
  }
} finally {
  $dlg.Dispose()
  $owner.Dispose()
}
`;

export const WINDOWS_FOLDER_PICKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
[System.Windows.Forms.Application]::EnableVisualStyles()

$initDir = $env:PAPERCUP_PICKER_INIT
$dlgTitle = $env:PAPERCUP_PICKER_TITLE
if ([string]::IsNullOrWhiteSpace($dlgTitle)) { $dlgTitle = '选择游戏工作区目录' }

$cs = @'
using System;
using System.Runtime.InteropServices;

namespace PaperCupNative {
  [ComImport]
  [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  internal class FileOpenDialogRCW {}

  [ComImport]
  [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }

  [ComImport]
  [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
    void GetResults(out IntPtr ppenum);
    void GetSelectedItems(out IntPtr ppsai);
  }

  public static class FolderDialog {
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
      string pszPath,
      IntPtr pbc,
      ref Guid riid,
      out IShellItem ppv
    );

    public static string Pick(IntPtr owner, string initialDir, string title) {
      IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
      try {
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (!string.IsNullOrEmpty(title)) {
          dialog.SetTitle(title);
        }
        if (!string.IsNullOrEmpty(initialDir)) {
          Guid shellItemGuid = typeof(IShellItem).GUID;
          IShellItem folderItem;
          if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref shellItemGuid, out folderItem) == 0 && folderItem != null) {
            dialog.SetFolder(folderItem);
            Marshal.ReleaseComObject(folderItem);
          }
        }
        int hr = dialog.Show(owner);
        if (hr == ERROR_CANCELLED) {
          return null;
        }
        if (hr != 0) {
          Marshal.ThrowExceptionForHR(hr);
        }
        IShellItem resultItem;
        dialog.GetResult(out resultItem);
        if (resultItem == null) return null;
        try {
          string path;
          resultItem.GetDisplayName(SIGDN_FILESYSPATH, out path);
          return path;
        } finally {
          Marshal.ReleaseComObject(resultItem);
        }
      } finally {
        Marshal.ReleaseComObject(dialog);
      }
    }
  }
}
'@

$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Opacity = 0

try {
  $owner.Show()
  $owner.Activate()
  $selected = $null
  try {
    if (-not ([System.Management.Automation.PSTypeName]'PaperCupNative.FolderDialog').Type) {
      Add-Type -TypeDefinition $cs -Language CSharp | Out-Null
    }
    $selected = [PaperCupNative.FolderDialog]::Pick($owner.Handle, $initDir, $dlgTitle)
  } catch {
    $fb = New-Object System.Windows.Forms.FolderBrowserDialog
    $fb.Description = $dlgTitle
    $fb.ShowNewFolderButton = $false
    if (-not [string]::IsNullOrWhiteSpace($initDir) -and (Test-Path -LiteralPath $initDir -PathType Container)) {
      $fb.SelectedPath = $initDir
    }
    try {
      $res = $fb.ShowDialog($owner)
      if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
        $selected = $fb.SelectedPath
      }
    } finally {
      $fb.Dispose()
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($selected)) {
    [Console]::Out.Write($selected)
  }
} finally {
  $owner.Dispose()
}
`;

function resolveInitialDir(initialDir?: string): string | undefined {
  if (!initialDir || !initialDir.trim()) return undefined;
  try {
    const cleaned = initialDir.trim().replace(/^"(.*)"$/, '$1');
    const resolved = path.resolve(cleaned);
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (st.isDirectory()) return resolved;
      if (st.isFile()) return path.dirname(resolved);
    }
    const parent = path.dirname(resolved);
    if (fs.existsSync(parent) && fs.statSync(parent).isDirectory()) {
      return parent;
    }
  } catch {
    // Ignore invalid initialDir hint
  }
  return undefined;
}

function validatePickedTarget(rawPath: string, kind: 'directory' | 'file'): FolderPickResult {
  const cleaned = rawPath.replace(/[\r\n]+$/g, '').trim();
  if (!cleaned) {
    return { canceled: true, path: null };
  }
  const resolved = path.resolve(cleaned);
  if (kind === 'directory') {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`所选路径不是有效目录：${resolved}`);
    }
  } else {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`所选路径不是有效文件：${resolved}`);
    }
  }
  return { canceled: false, path: resolved };
}

async function pickFolderWindows(initialDir: string | undefined, title: string): Promise<FolderPickResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (initialDir) {
    env.PAPERCUP_PICKER_INIT = initialDir;
  } else {
    delete env.PAPERCUP_PICKER_INIT;
  }
  env.PAPERCUP_PICKER_TITLE = title;

  const encoded = Buffer.from(WINDOWS_FOLDER_PICKER_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    {
      env,
      windowsHide: true,
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }
  );
  return validatePickedTarget(stdout || '', 'directory');
}

async function pickFileWindows(
  initialDir: string | undefined,
  title: string,
  filter: string
): Promise<FolderPickResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (initialDir) {
    env.PAPERCUP_PICKER_INIT = initialDir;
  } else {
    delete env.PAPERCUP_PICKER_INIT;
  }
  env.PAPERCUP_PICKER_TITLE = title;
  env.PAPERCUP_PICKER_FILTER = filter;

  const encoded = Buffer.from(WINDOWS_FILE_PICKER_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
    {
      env,
      windowsHide: true,
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }
  );
  return validatePickedTarget(stdout || '', 'file');
}

async function pickFolderMac(initialDir: string | undefined, title: string): Promise<FolderPickResult> {
  const safePrompt = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const scriptLines = initialDir
    ? [
        `set defaultAlias to POSIX file ${JSON.stringify(initialDir)}`,
        `POSIX path of (choose folder with prompt "${safePrompt}" default location defaultAlias)`,
      ]
    : [`POSIX path of (choose folder with prompt "${safePrompt}")`];
  try {
    const { stdout } = await execFileAsync('osascript', scriptLines.flatMap((line) => ['-e', line]), {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return validatePickedTarget(stdout || '', 'directory');
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || '');
    if (err?.code === 1 || /-128/.test(msg) || /User canceled/i.test(msg)) {
      return { canceled: true, path: null };
    }
    throw new Error(`系统目录选择器调用失败：${msg || '未知错误'}`);
  }
}

async function pickFileMac(initialDir: string | undefined, title: string): Promise<FolderPickResult> {
  const safePrompt = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const scriptLines = initialDir
    ? [
        `set defaultAlias to POSIX file ${JSON.stringify(initialDir)}`,
        `POSIX path of (choose file with prompt "${safePrompt}" default location defaultAlias)`,
      ]
    : [`POSIX path of (choose file with prompt "${safePrompt}")`];
  try {
    const { stdout } = await execFileAsync('osascript', scriptLines.flatMap((line) => ['-e', line]), {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return validatePickedTarget(stdout || '', 'file');
  } catch (err: any) {
    const msg = String(err?.stderr || err?.message || '');
    if (err?.code === 1 || /-128/.test(msg) || /User canceled/i.test(msg)) {
      return { canceled: true, path: null };
    }
    throw new Error(`系统文件选择器调用失败：${msg || '未知错误'}`);
  }
}

async function pickFolderLinux(initialDir: string | undefined, title: string): Promise<FolderPickResult> {
  const zenityArgs = ['--file-selection', '--directory', `--title=${title}`];
  if (initialDir) {
    zenityArgs.push(`--filename=${initialDir.endsWith('/') ? initialDir : `${initialDir}/`}`);
  }
  try {
    const { stdout } = await execFileAsync('zenity', zenityArgs, {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return validatePickedTarget(stdout || '', 'directory');
  } catch (err: any) {
    if (err?.code === 1) {
      return { canceled: true, path: null };
    }
    if (err?.code !== 'ENOENT') {
      throw new Error(`系统目录选择器调用失败：${err?.message || err}`);
    }
  }

  const kdialogArgs = ['--getexistingdirectory', initialDir || process.cwd(), '--title', title];
  try {
    const { stdout } = await execFileAsync('kdialog', kdialogArgs, {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return validatePickedTarget(stdout || '', 'directory');
  } catch (err: any) {
    if (err?.code === 1) {
      return { canceled: true, path: null };
    }
    if (err?.code === 'ENOENT') {
      throw new Error('当前系统环境未安装原生目录选择器（zenity / kdialog），请在输入框中直接输入目录路径。');
    }
    throw new Error(`系统目录选择器调用失败：${err?.message || err}`);
  }
}

async function pickFileLinux(initialDir: string | undefined, title: string): Promise<FolderPickResult> {
  const zenityArgs = ['--file-selection', `--title=${title}`];
  if (initialDir) {
    zenityArgs.push(`--filename=${initialDir.endsWith('/') ? initialDir : `${initialDir}/`}`);
  }
  try {
    const { stdout } = await execFileAsync('zenity', zenityArgs, {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return validatePickedTarget(stdout || '', 'file');
  } catch (err: any) {
    if (err?.code === 1) {
      return { canceled: true, path: null };
    }
    if (err?.code !== 'ENOENT') {
      throw new Error(`系统文件选择器调用失败：${err?.message || err}`);
    }
  }

  const kdialogArgs = ['--getopenfilename', initialDir || process.cwd(), '*', '--title', title];
  try {
    const { stdout } = await execFileAsync('kdialog', kdialogArgs, {
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return validatePickedTarget(stdout || '', 'file');
  } catch (err: any) {
    if (err?.code === 1) {
      return { canceled: true, path: null };
    }
    if (err?.code === 'ENOENT') {
      throw new Error('当前系统环境未安装原生文件选择器（zenity / kdialog），请在输入框中直接输入可执行文件路径。');
    }
    throw new Error(`系统文件选择器调用失败：${err?.message || err}`);
  }
}

export async function pickFolderNative(options?: {
  initialDir?: string;
  title?: string;
}): Promise<FolderPickResult> {
  const initialDir = resolveInitialDir(options?.initialDir);
  const title = options?.title?.trim() || DEFAULT_TITLE;

  if (process.platform === 'win32') {
    return pickFolderWindows(initialDir, title);
  }
  if (process.platform === 'darwin') {
    return pickFolderMac(initialDir, title);
  }
  return pickFolderLinux(initialDir, title);
}

export async function pickFileNative(options?: {
  initialPath?: string;
  title?: string;
  filter?: string;
}): Promise<FolderPickResult> {
  const initialDir = resolveInitialDir(options?.initialPath);
  const title = options?.title?.trim() || DEFAULT_FILE_TITLE;
  const filter = options?.filter?.trim() || DEFAULT_FILE_FILTER;

  if (process.platform === 'win32') {
    return pickFileWindows(initialDir, title, filter);
  }
  if (process.platform === 'darwin') {
    return pickFileMac(initialDir, title);
  }
  return pickFileLinux(initialDir, title);
}
