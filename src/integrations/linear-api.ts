// Thin wrapper around Linear's GraphQL endpoint. Token comes from LINEAR_API_TOKEN
// which is loaded from ~/.outpost/.env by env-file.ts during daemon boot.

const ENDPOINT = 'https://api.linear.app/graphql';

export class LinearError extends Error {
  // Linear flags a request it will never accept, however often it's sent ("This URL has already
  // been linked with CLT-1923."), as `extensions.userError`. A retry can't fix one of those.
  constructor(public readonly status: number, message: string, public readonly userError = false) {
    super(message);
    this.name = 'LinearError';
  }
}

export async function linearQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { token?: string } = {},
): Promise<T> {
  const token = opts.token ?? process.env.LINEAR_API_TOKEN;
  if (!token) throw new LinearError(0, 'LINEAR_API_TOKEN missing from ~/.outpost/.env');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LinearError(res.status, `linear http ${res.status}: ${text.slice(0, 200)}`);
  }
  type GqlError = { message: string; extensions?: { userError?: boolean; userPresentableMessage?: string } };
  const body = await res.json() as { data?: T; errors?: GqlError[] };
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.extensions?.userPresentableMessage ?? e.message).join('; ');
    throw new LinearError(200, `linear graphql: ${msg}`, body.errors.every((e) => e.extensions?.userError));
  }
  if (body.data === undefined) throw new LinearError(200, 'linear graphql: no data field');
  return body.data;
}
