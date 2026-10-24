const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const sourcePath = path.join(__dirname, '..', 'src', 'utils', 'mongo-filters.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const compiled = ts.transpile(source, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
});
const testModule = new Module(sourcePath, module);
testModule.filename = sourcePath;
testModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
testModule._compile(compiled, sourcePath);
const { rewriteMongoNotDeletedArgs } = testModule.exports;

test('preserves Date instances and identity', () => {
  const date = new Date('2026-10-22T14:30:00.000Z');
  const result = rewriteMongoNotDeletedArgs({
    where: { dispatchDueAt: { lte: date } },
  });
  assert.ok(result.where.dispatchDueAt.lte instanceof Date);
  assert.strictEqual(result.where.dispatchDueAt.lte, date);
});

test('preserves Dates in nested logical filters', () => {
  const date = new Date('2026-10-22T14:30:00.000Z');
  const result = rewriteMongoNotDeletedArgs({
    where: {
      OR: [
        { dispatchDueAt: { lte: date } },
        { AND: [{ createdAt: { gte: date } }] },
      ],
    },
  });
  assert.strictEqual(result.where.OR[0].dispatchDueAt.lte, date);
  assert.strictEqual(result.where.OR[1].AND[0].createdAt.gte, date);
});

test('rewrites deletedAt null', () => {
  const result = rewriteMongoNotDeletedArgs({ where: { deletedAt: null } });
  assert.deepStrictEqual(result.where.deletedAt, { isSet: false });
});

test('rewrites deletedAt equals null', () => {
  const result = rewriteMongoNotDeletedArgs({
    where: { deletedAt: { equals: null } },
  });
  assert.deepStrictEqual(result.where.deletedAt, { isSet: false });
});

test('does not mutate input and preserves unrelated filters', () => {
  const date = new Date('2026-10-22T14:30:00.000Z');
  const args = {
    where: {
      deletedAt: null,
      status: 'PENDING',
      dispatchDueAt: { lte: date },
    },
  };
  const result = rewriteMongoNotDeletedArgs(args);
  assert.strictEqual(args.where.deletedAt, null);
  assert.strictEqual(args.where.dispatchDueAt.lte, date);
  assert.equal(result.where.status, 'PENDING');
  assert.notStrictEqual(result, args);
});
