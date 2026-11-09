'use client';

import { Dialog, DialogActions } from '@/components/dialog';

interface Props {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onCancel()}
      variant="modal"
      title={title}
      description={description}
    >
      <DialogActions>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium text-navy hover:bg-cream-warm"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={
            destructive
              ? 'rounded-md bg-severity-critical px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:opacity-90'
              : 'rounded-md bg-orange px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-orange-deep'
          }
        >
          {confirmLabel}
        </button>
      </DialogActions>
    </Dialog>
  );
}
