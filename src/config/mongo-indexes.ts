import { prisma } from './prisma';
import { logger } from './logger';

async function ensureSparseUniqueIndex(collection: string, name: string, key: Record<string, 1>) {
  try {
    await prisma.$runCommandRaw({ dropIndexes: collection, index: name });
  } catch {
    // Index may not exist yet on a fresh cluster.
  }
  await prisma.$runCommandRaw({
    createIndexes: collection,
    indexes: [{ key, name, unique: true, sparse: true }],
  });
}

/**
 * Mongo unique indexes treat missing/null as a value, so only one user could omit firebaseUid/phone
 * unless the index is sparse. Prisma db push creates non-sparse uniques; this restores sparse ones.
 */
export async function ensureMongoSparseUniqueIndexes(): Promise<void> {
  await ensureSparseUniqueIndex('User', 'User_firebaseUid_key', { firebaseUid: 1 });
  await ensureSparseUniqueIndex('User', 'User_phone_key', { phone: 1 });
  await ensureSparseUniqueIndex('Payment', 'Payment_idempotencyKey_key', { idempotencyKey: 1 });
  await ensureSparseUniqueIndex('Refund', 'Refund_idempotencyKey_key', { idempotencyKey: 1 });
  await prisma.$runCommandRaw({
    update: 'User',
    updates: [
      { q: { firebaseUid: null }, u: { $unset: { firebaseUid: '' } }, multi: true },
      { q: { phone: null }, u: { $unset: { phone: '' } }, multi: true },
      { q: { deletedAt: null }, u: { $unset: { deletedAt: '' } }, multi: true },
    ],
  });
  await prisma.$runCommandRaw({
    update: 'Service',
    updates: [{ q: { deletedAt: null }, u: { $unset: { deletedAt: '' } }, multi: true }],
  });
  await prisma.$runCommandRaw({
    update: 'ServiceCategory',
    updates: [{ q: { deletedAt: null }, u: { $unset: { deletedAt: '' } }, multi: true }],
  });
  try {
    await prisma.$runCommandRaw({
      createIndexes: 'OtpChallenge',
      indexes: [
        {
          key: { expiresAt: 1 },
          name: 'OtpChallenge_expiresAt_ttl_idx',
          expireAfterSeconds: 0,
        },
      ],
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to create OtpChallenge TTL index');
  }

    logger.info('MongoDB sparse unique indexes ensured');
}
