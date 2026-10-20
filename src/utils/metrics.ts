import { AsyncLocalStorage } from 'async_hooks';

export interface RequestMetrics {
  requestId: string;
  startTime: number;
  dbDurationMs: number;
  dbQueryCount: number;
}

export const requestMetricsStore = new AsyncLocalStorage<RequestMetrics>();

export const recordDbQueryMetric = (durationMs: number): void => {
  const store = requestMetricsStore.getStore();
  if (store) {
    store.dbDurationMs += durationMs;
    store.dbQueryCount += 1;
  }
};
