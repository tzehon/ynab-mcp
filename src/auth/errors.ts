export class AuthError extends Error {
  constructor(
    public readonly kind:
      | "invalid"
      | "owner"
      | "scope"
      | "unavailable"
      | "missing",
  ) {
    super("AUTH_REJECTED");
  }
}
export function invalid(): never {
  throw new AuthError("invalid");
}
