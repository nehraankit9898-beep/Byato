/** Shared startup/runtime validation for CSP embedding. No URLs with paths,
 * credentials, wildcards or directive delimiters may become policy tokens. */
export function frameAncestors(raw: string | undefined, production: boolean): string {
  const tokens = (raw ?? "")
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!tokens.length) return production ? "'self'" : "*";
  if (tokens.includes("'none'")) {
    if (tokens.length === 1) return "'none'";
    throw new Error("'none' must be the only frame ancestor");
  }
  return tokens
    .map((token) => {
      if (token === "'self'") return token;
      if (token === "*" && !production) return token;
      const url = new URL(token);
      if (
        (url.protocol !== "https:" && (production || url.protocol !== "http:")) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        token.includes("*") ||
        token.includes(";") ||
        token.includes("\\") ||
        // Reject URL-parser repairs such as https:host, empty query/fragment,
        // or encoded/extra path segments, rather than silently broadening access.
        ![url.origin, `${url.origin}/`].includes(token)
      ) {
        throw new Error("frame ancestors must be explicit origins");
      }
      return url.origin;
    })
    .join(" ");
}
