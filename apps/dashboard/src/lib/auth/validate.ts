export const MIN_PASSWORD_LENGTH = 12;

export function validatePasswordPair(next: string, confirm: string): string | null {
  if (next !== confirm) return "Passwords don't match";
  if (next.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}

export function passwordStrengthScore(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  let score = 0;
  if (password.length >= MIN_PASSWORD_LENGTH) score++;
  if (password.length >= 16) score++;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score++;
  return Math.min(score, 4) as 0 | 1 | 2 | 3 | 4;
}
