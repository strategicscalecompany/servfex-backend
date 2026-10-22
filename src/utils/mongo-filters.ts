/**
 * Prisma Mongo `{ deletedAt: null }` only matches a BSON null field.
 * Seeded/created docs omit the field, so list APIs return empty until the
 * filter is rewritten to `{ deletedAt: { isSet: false } }`.
 */
const UNSET_DELETED_AT = { isSet: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (value instanceof Date || value instanceof RegExp || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNullEqualsFilter(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'equals' && value.equals === null;
}

function rewriteDeletedAtFilter(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(rewriteDeletedAtFilter);
  }
  if (!isPlainObject(node)) {
    return node;
  }

  const input = node;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'deletedAt' && isNullEqualsFilter(value)) {
      output[key] = UNSET_DELETED_AT;
    } else {
      output[key] = rewriteDeletedAtFilter(value);
    }
  }
  return output;
}

function rewriteWhereKeys(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(rewriteWhereKeys);
  }
  if (!isPlainObject(node)) {
    return node;
  }

  const input = node;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'where') {
      output[key] = rewriteDeletedAtFilter(value);
    } else {
      output[key] = rewriteWhereKeys(value);
    }
  }
  return output;
}

export function rewriteMongoNotDeletedArgs<T>(args: T): T {
  if (!isPlainObject(args)) {
    return args;
  }
  return rewriteWhereKeys(args) as T;
}
