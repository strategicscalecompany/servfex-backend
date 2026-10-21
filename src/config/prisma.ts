import { PrismaClient } from '@prisma/client';
import { env } from './env';
import { logger } from './logger';
import { recordDbQueryMetric } from '../utils/metrics';

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

function runtimeDatabaseUrl(): string {
  // This is a long-running Node process with interactive $transaction locks.
  // Supabase port 6543 is PgBouncer transaction mode and makes those locks
  // wait 10–20s. DIRECT_URL (session pooler :5432) is the correct runtime URL.
  const direct = env.DIRECT_URL?.trim();
  return direct && direct.length > 0 ? direct : env.DATABASE_URL;
}

const basePrisma =
  globalThis.prismaGlobal ??
  new PrismaClient({
    datasources: { db: { url: runtimeDatabaseUrl() } },
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

const extendedPrisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }: any) {
        const start = performance.now();
        try {
          return await query(args);
        } finally {
          const duration = performance.now() - start;
          recordDbQueryMetric(duration);
          if (duration > 200) {
            logger.warn(
              { model, operation, durationMs: Number(duration.toFixed(2)) },
              'Slow database query detected'
            );
          }
        }
      },
    },
  },
});

export const prisma: PrismaClient = extendedPrisma as unknown as PrismaClient;

if (env.NODE_ENV !== 'production') {
  globalThis.prismaGlobal = basePrisma;
}
