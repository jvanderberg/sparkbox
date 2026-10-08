/**
 * The one step of GitHub sign-in a browser cannot do itself: swapping the
 * authorization code for a token, which needs the OAuth app's secret and an
 * endpoint without CORS. The token goes straight back to the browser; the
 * host keeps nothing.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function exchangeGitHubCode(
  options: { clientId: string; clientSecret: string; code: string },
  fetchFn: FetchLike = (input, init) => fetch(input, init),
): Promise<{ token: string } | { error: string }> {
  const code = options.code.trim();
  if (!code || code.length > 200 || !/^[\w-]+$/.test(code))
    return { error: "Send a sign-in code." };
  let response: Response;
  try {
    response = await fetchFn("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code,
      }),
    });
  } catch (error) {
    return {
      error: `The host could not reach GitHub: ${error instanceof Error ? error.message : error}`,
    };
  }
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token)
    return {
      error: data.error_description ?? data.error ?? `GitHub returned ${response.status}.`,
    };
  return { token: data.access_token };
}
