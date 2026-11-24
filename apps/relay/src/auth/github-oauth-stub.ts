export const GITHUB_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "api.github.com",
]);

export interface GitHubStubProfile {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface GitHubOAuthStub {
  fetch: typeof fetch;
  requests: URL[];
  issuedCodes: Set<string>;
  setProfile(profile: GitHubStubProfile): void;
  issueCode(): string;
}

function readUrl(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;

  if (typeof input === "string") return new URL(input);

  return new URL(input.url);
}

export function createGitHubOAuthStub(
  initial: GitHubStubProfile,
): GitHubOAuthStub {
  let profile = initial;
  let codeCounter = 0;
  const requests: URL[] = [];
  const issuedCodes = new Set<string>();
  const accessTokens = new Map<string, GitHubStubProfile>();

  const stubFetch: typeof fetch = async (input, init) => {
    const url = readUrl(input);
    requests.push(url);

    if (!GITHUB_ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`unexpected outbound request to ${url.hostname}`);
    }

    if (
      url.hostname === "github.com" &&
      url.pathname === "/login/oauth/access_token"
    ) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      const code = body.get("code") ?? "";

      if (!issuedCodes.delete(code)) {
        return Response.json({ error: "bad_verification_code" });
      }

      const token = `stub-access-${code}`;
      accessTokens.set(token, profile);

      return Response.json({
        access_token: token,
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }

    const headers = new Headers(init?.headers);

    const presented = /^Bearer\s+(.+)$/iu.exec(
      headers.get("authorization") ?? "",
    )?.[1];

    const owner =
      presented === undefined ? undefined : accessTokens.get(presented);

    if (owner === undefined) {
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    }

    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({
        id: owner.id,
        login: owner.login,
        name: owner.name,
        email: null,
        avatar_url: `https://avatars.githubusercontent.com/u/${owner.id}`,
      });
    }

    if (url.hostname === "api.github.com" && url.pathname === "/user/emails") {
      return Response.json([
        { email: owner.email, primary: true, verified: true },
      ]);
    }

    return Response.json({ message: "Not Found" }, { status: 404 });
  };

  return {
    fetch: stubFetch,
    requests,
    issuedCodes,
    setProfile(next) {
      profile = next;
    },
    issueCode() {
      codeCounter += 1;
      const code = `stub-code-${codeCounter}`;
      issuedCodes.add(code);

      return code;
    },
  };
}

export interface ParsedSetCookie {
  raw: string;
  name: string;
  value: string;
  attributes: Map<string, string>;
}

export function parseSetCookie(raw: string): ParsedSetCookie {
  const [pair = "", ...rest] = raw.split(";");
  const separator = pair.indexOf("=");
  const attributes = new Map<string, string>();

  for (const attribute of rest) {
    const trimmed = attribute.trim();

    if (trimmed === "") continue;
    const equals = trimmed.indexOf("=");

    if (equals === -1) attributes.set(trimmed.toLowerCase(), "");
    else
      attributes.set(
        trimmed.slice(0, equals).toLowerCase(),
        trimmed.slice(equals + 1),
      );
  }

  return {
    raw,
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    attributes,
  };
}

export function isExpiredSetCookie(cookie: ParsedSetCookie): boolean {
  const maxAge = cookie.attributes.get("max-age");

  if (maxAge !== undefined) return Number(maxAge) <= 0;
  const expires = cookie.attributes.get("expires");

  return expires !== undefined && Date.parse(expires) <= Date.now();
}
