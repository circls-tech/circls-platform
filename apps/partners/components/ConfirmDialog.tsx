'use client';

import { Button, Modal } from '@/lib/ui';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Hold the confirm button, e.g. while the message is still being worked out. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  confirmDisabled = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      <div className="flex flex-col gap-6">
        <p className="text-sm text-slate-600">{message}</p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            disabled={confirmDisabled}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
