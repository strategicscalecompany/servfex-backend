import { Prisma } from '@prisma/client';

/**
 * Prisma MongoDB does not support Decimal128. Money and 2-decimal rates are stored as
 * canonical rupee strings ("1499.00"). All arithmetic must go through Decimal.js, never JS floats.
 */
export function toMoney(value: Prisma.Decimal | number | string | null | undefined): string {
  if (value == null || value === '') return '0.00';
  return new Prisma.Decimal(value.toString()).toFixed(2);
}

export function toMoneyOrNull(value: Prisma.Decimal | number | string | null | undefined): string | null {
  if (value == null || value === '') return null;
  return toMoney(value);
}

export function asDecimal(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  if (value == null || value === '') return new Prisma.Decimal(0);
  return new Prisma.Decimal(value.toString());
}

export function sumMoney(values: Array<Prisma.Decimal | number | string | null | undefined>): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  for (const value of values) {
    total = total.plus(asDecimal(value));
  }
  return total;
}
