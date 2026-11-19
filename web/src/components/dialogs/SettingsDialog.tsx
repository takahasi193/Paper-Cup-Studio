import * as React from 'react';
import { KeyRound, SlidersHorizontal } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog.js';
import { ColorSchemePreference, ResolvedColorScheme } from '@/hooks/useColorScheme.js';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  preference: ColorSchemePreference;
  systemScheme: ResolvedColorScheme;
  onSelectScheme: (pref: ColorSchemePreference, origin?: { x: number; y: number }) => void;
  ambientEnabled: boolean;
  onToggleAmbient: (enabled: boolean) => void;
  onOpenApiKey: () => void;
  busy?: boolean;
}

export function SettingsDialog({
  isOpen,
  onClose,
  preference,
  systemScheme,
  onSelectScheme,
  ambientEnabled,
  onToggleAmbient,
  onOpenApiKey,
  busy = false,
}: SettingsDialogProps) {
  const systemLabel = `跟随系统（当前：${systemScheme === 'dark' ? '深色' : '浅色'}）`;
  const lastPointerRef = React.useRef<{ x: number; y: number } | undefined>(undefined);

  const capturePointer = (e: React.PointerEvent) => {
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="设置"
      icon={<SlidersHorizontal className="size-4 text-string" aria-hidden="true" />}
    >
      <div className="space-y-6 p-5">
        <fieldset className="space-y-2.5">
          <legend className="text-xs font-semibold text-ink-2">外观</legend>
          <div className="space-y-2" onPointerDown={capturePointer}>
            <label className="pc-radio-card">
              <input
                type="radio"
                name="color-scheme"
                value="system"
                checked={preference === 'system'}
                data-autofocus=""
                onChange={() => onSelectScheme('system', lastPointerRef.current)}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">{systemLabel}</span>
                <span className="text-xs text-ink-3">随操作系统浅色与深色自动切换</span>
              </span>
            </label>

            <label className="pc-radio-card">
              <input
                type="radio"
                name="color-scheme"
                value="light"
                checked={preference === 'light'}
                onChange={() => onSelectScheme('light', lastPointerRef.current)}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">浅色「纸」</span>
                <span className="text-xs text-ink-3">暖象牙纸底配朱红细线</span>
              </span>
            </label>

            <label className="pc-radio-card">
              <input
                type="radio"
                name="color-scheme"
                value="dark"
                checked={preference === 'dark'}
                onChange={() => onSelectScheme('dark', lastPointerRef.current)}
                className="size-4 shrink-0"
              />
              <span className="flex flex-1 flex-col">
                <span className="text-[0.8125rem] font-medium text-ink">深色「夜」</span>
                <span className="text-xs text-ink-3">夜蓝墨底配亮朱红弦</span>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-1 border-t border-line pt-4">
          <legend className="sr-only">动效偏好</legend>
          <label className="pc-checkbox-label">
            <input
              type="checkbox"
              name="ambient-motion"
              checked={ambientEnabled}
              onChange={(e) => onToggleAmbient(e.target.checked)}
              className="size-4 shrink-0"
            />
            <span className="text-[0.8125rem] font-medium text-ink">环境动效</span>
          </label>
          <p className="pl-6 text-xs text-ink-3">
            控制空状态纸杯声波、红线信号与对话短句轮换；系统开启减弱动态效果时将自动静止。
          </p>
        </fieldset>

        <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
          <div className="min-w-0">
            <div className="text-[0.8125rem] font-medium text-ink">模型凭据</div>
            <p className="text-xs text-ink-3">配置或切换模型提供商 API Key</p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              onClose();
              onOpenApiKey();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-line-strong bg-well px-3.5 py-2 text-xs font-medium text-ink transition-colors hover:border-string hover:text-string-ink disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            <span>管理 API Key</span>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
