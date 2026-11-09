'use client';

import { forwardRef, useId, useState } from 'react';
import { MIN_PASSWORD_LENGTH, passwordStrengthScore } from '@/lib/auth/validate';

interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  showStrength?: boolean;
  showLengthHint?: boolean;
}

const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const;
const STRENGTH_COLORS = [
  'bg-border',
  'bg-severity-critical',
  'bg-severity-medium',
  'bg-severity-high',
  'bg-status-success',
] as const;

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput(
    { label, showStrength = false, showLengthHint = false, id, value, className, ...rest },
    ref,
  ) {
    const reactId = useId();
    const inputId = id ?? reactId;
    const [visible, setVisible] = useState(false);
    const strValue = typeof value === 'string' ? value : '';
    const score = showStrength ? passwordStrengthScore(strValue) : 0;
    const meetsLength = strValue.length >= MIN_PASSWORD_LENGTH;

    return (
      <div>
        <label htmlFor={inputId} className="block text-sm font-medium text-navy">
          {label}
        </label>
        <div className="relative mt-1">
          <input
            ref={ref}
            id={inputId}
            type={visible ? 'text' : 'password'}
            value={value}
            {...rest}
            className={
              className ??
              'block w-full rounded-md border border-border bg-white px-3 py-2 pr-10 text-sm text-navy shadow-sm focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/30'
            }
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? 'Hide password' : 'Show password'}
            aria-pressed={visible}
            tabIndex={-1}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-text hover:text-navy"
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {showStrength && strValue.length > 0 && (
          <div className="mt-2">
            <div className="flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((seg) => (
                <span
                  key={seg}
                  className={`h-1 flex-1 rounded-full ${
                    score >= seg ? STRENGTH_COLORS[score] : 'bg-border-light'
                  }`}
                />
              ))}
            </div>
            <p className="mt-1 text-xs text-gray-text" aria-live="polite">
              Strength: {STRENGTH_LABELS[score]}
            </p>
          </div>
        )}
        {showLengthHint && (
          <p
            className={`mt-1 text-xs ${meetsLength ? 'text-status-success' : 'text-gray-text'}`}
            aria-live="polite"
          >
            {meetsLength ? '✓ ' : ''}Minimum {MIN_PASSWORD_LENGTH} characters
          </p>
        )}
      </div>
    );
  },
);

function EyeIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a19.77 19.77 0 014.16-5.94M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 8 11 8a19.86 19.86 0 01-3.16 4.19M9.88 9.88a3 3 0 104.24 4.24M1 1l22 22"
      />
    </svg>
  );
}
