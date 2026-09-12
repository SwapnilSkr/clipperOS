export interface ErrorWithMessage {
  message: string;
}

export interface NodeError extends Error {
  code?: string;
}

export function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

export function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) return error.message;
  if (typeof error === "string") return error;
  return "An unknown error occurred";
}
