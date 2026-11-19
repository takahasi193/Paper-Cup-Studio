import { CircleAlert } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog.js';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = '删除',
  busy = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      icon={<CircleAlert className="size-4 text-danger" aria-hidden="true" />}
      maxWidthClass="max-w-md"
    >
      <div className="space-y-5 p-5">
        <p className="text-sm leading-relaxed text-ink-2">{description}</p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-autofocus=""
            onClick={onClose}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-xl border border-line px-4 py-1.5 text-[0.8125rem] font-medium text-ink transition-colors hover:bg-well disabled:opacity-45 cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-xl bg-danger px-4 py-1.5 text-[0.8125rem] font-medium text-on-string transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
