import { env } from './env';
import { prisma } from './prisma';
import { logger } from './logger';

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

/** Upsert allowlisted Super Admins on every boot so Google login can bind firebaseUid. */
export async function ensureAllowlistedSuperAdmins(): Promise<void> {
  const emails = parseSuperAdminEmails();
  for (const email of emails) {
    await prisma.user.upsert({
      where: { email },
      update: {
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        isVerified: true,
        name: superAdminDisplayName(email),
      },
      create: {
        email,
        name: superAdminDisplayName(email),
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        isVerified: true,
      },
    });
  }
  logger.info({ emails }, 'Allowlisted Super Admin accounts ensured');
}
