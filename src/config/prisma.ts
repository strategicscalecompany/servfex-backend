import { PrismaClient } from '@prisma/client';
import { env } from './env';
import { logger } from './logger';
import { recordDbQueryMetric } from '../utils/metrics';

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

function runtimeDatabaseUrl(): string {
  const mongo = env.MONGODB_URI?.trim();
  if (mongo) return mongo;
  return env.DATABASE_URL;
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
