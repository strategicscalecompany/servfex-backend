const UPI_ID_PATTERN = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

export function normalizeUpiId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidUpiId(value: unknown): boolean {
  return UPI_ID_PATTERN.test(normalizeUpiId(value));
}

export function formatRupeeAmount(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return '0.00';
  return numeric.toFixed(2);
}

export function buildUpiPaymentUri(params: {
  upiId: string;
  payeeName: string;
  amount: string;
  transactionRef: string;
  note: string;
}): string {
  const query = new URLSearchParams({
    pa: normalizeUpiId(params.upiId),
    pn: params.payeeName.slice(0, 99) || 'ServFex Professional',
    am: formatRupeeAmount(params.amount),
    cu: 'INR',
    tn: params.note.slice(0, 99),
    tr: params.transactionRef.slice(0, 35),
  });
  return `upi://pay?${query.toString()}`;
}
