import { ZodError, type ZodType } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Expected a JSON request body.");
  }
  return schema.parse(body);
}

export function errorResponse(error: unknown): Response {
  console.error(error);
  if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) {
    return Response.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return Response.json({ error: "That handle is already in use." }, { status: 409 });
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "Unexpected server error." },
    { status: 500 },
  );
}

export function absoluteAppUrl(request: Request, target: string): string {
  return new URL(target, `${appUrl(request)}/`).toString();
}

export function appUrl(request?: Request): string {
  return (process.env.APP_URL ?? (request ? new URL(request.url).origin : "http://localhost:3000")).replace(/\/$/, "");
}
