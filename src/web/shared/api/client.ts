// Shared HTTP client: JSON error extraction, credential handling and message formatting for API calls.
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Perform a JSON-credentials request, surfacing the server's error message on failure.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the generic status message.
    }
    throw new ApiError(message, response.status);
  }
  const contentType = response.headers.get("content-type") || "";
  return (contentType.includes("application/json") ? await response.json() : await response.text()) as T;
}

// Extract a human-readable message from an unknown thrown value.
export function messageOf(value: unknown): string {
  return value instanceof ApiError || value instanceof Error ? value.message : String(value);
}
