import { env } from './env';

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/**
 * Allowlisted Super Admin emails. First verified Google login binds firebaseUid
 * and promotes the account. Seeded from SUPER_ADMIN_EMAIL + SUPER_ADMIN_EMAILS.
 */
export function parseSuperAdminEmails(): string[] {
  const fromList = (env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
  const primary = env.SUPER_ADMIN_EMAIL ? normalizeEmail(env.SUPER_ADMIN_EMAIL) : '';
  return [...new Set([primary, ...fromList].filter(Boolean))];
}

export function isAllowlistedSuperAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return parseSuperAdminEmails().includes(normalizeEmail(email));
}

export function superAdminDisplayName(email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized === 'vamshi.c2002@gmail.com') return 'Vamshi';
  if (normalized === 'strategicscalecompany@gmail.com') return 'Strategic Scale';
  return env.SUPER_ADMIN_NAME;
}
