'use client';

import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: 'modal' | 'drawer';
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  widthClassName?: string;
}

export function Dialog({
  open,
  onOpenChange,
  variant = 'modal',
  title,
  description,
  children,
  widthClassName,
}: DialogProps) {
  const isDrawer = variant === 'drawer';
  const contentClass = isDrawer
    ? `fixed inset-y-0 right-0 z-50 flex h-full ${widthClassName ?? 'w-[520px]'} flex-col overflow-y-auto border-l border-border bg-white shadow-xl transition-transform data-[state=open]:animate-in data-[state=closed]:animate-out`
    : `fixed left-1/2 top-1/2 z-50 w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-white p-6 shadow-xl ${widthClassName ?? 'max-w-md'}`;
  const overlayClass =
    'fixed inset-0 z-40 bg-navy/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out';

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={overlayClass} />
        <RadixDialog.Content className={contentClass} aria-describedby={undefined}>
          {(title || description) && (
            <div
              className={
                isDrawer
                  ? 'sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-white px-6 py-4'
                  : 'mb-4 flex items-start justify-between gap-3'
              }
            >
              <div>
                {title && (
                  <RadixDialog.Title className="text-lg font-medium text-navy">
                    {title}
                  </RadixDialog.Title>
                )}
                {description && (
                  <RadixDialog.Description className="mt-1 text-sm text-gray-text">
                    {description}
                  </RadixDialog.Description>
                )}
              </div>
              <RadixDialog.Close
                aria-label="Close"
                className="-mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-gray-text hover:bg-cream-warm hover:text-navy focus:outline-none focus:ring-2 focus:ring-orange/30"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </RadixDialog.Close>
            </div>
          )}
          <div className={isDrawer ? 'flex-1 px-6 py-4' : ''}>{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex justify-end gap-2">{children}</div>;
}
