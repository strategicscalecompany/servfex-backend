/** Error with a stable machine-readable code that controllers surface as-is (zero silent failures). */
export class DispatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 409
  ) {
    super(message);
    this.name = 'DispatchError';
  }
}
