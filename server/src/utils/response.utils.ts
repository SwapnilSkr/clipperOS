export function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

export function fail(error: string): { success: false; error: string } {
  return { success: false, error };
}
