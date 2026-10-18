import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

function check(value: string, production = true) {
  // Fresh process: proxy's production flag is fixed when the module is loaded.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { validateExtendedEnv } = await import('./src/lib/env.ts');
    const { proxy } = await import('./src/proxy.ts');
    const { NextRequest } = await import('next/server');
    const errors = validateExtendedEnv().errors.filter(e => e.includes('EMBED_FRAME_ANCESTORS'));
    const csp = proxy(new NextRequest('https://stayloop.example/')).headers.get('content-security-policy');
    console.log(JSON.stringify({errors, csp}));
  `,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: production ? "production" : "development",
        EMBED_FRAME_ANCESTORS: value,
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout.trim());
}

for (const value of [
  "*",
  "https://*.example.com",
  "https://trusted.example; script-src *",
  "https://trusted.example/path",
  "https://trusted.example?x=1",
  "http://trusted.example",
  "https://user:pass@trusted.example",
  "'none' https://trusted.example",
]) {
  test(`BUG-14 rejects unsafe production frame policy: ${value}`, () => {
    const result = check(value);
    expect(result.errors.length).toBeGreaterThan(0);
    // Defense in depth if startup validation was skipped: never emit unsafe input.
    expect(result.csp).toContain("frame-ancestors 'self'");
  });
}

test("BUG-14 trusted production origins are normalized into valid CSP tokens", () => {
  const result = check("'self', https://partner.example/ https://other.example:8443");
  expect(result.errors).toEqual([]);
  expect(result.csp).toContain(
    "frame-ancestors 'self' https://partner.example https://other.example:8443",
  );
  expect(result.csp).not.toContain("unsafe-eval");
});
test("BUG-14 safe defaults, deny-all and development embedding remain supported", () => {
  expect(check("").csp).toContain("frame-ancestors 'self'");
  expect(check("'none'").errors).toEqual([]);
  expect(check("'none'").csp).toContain("frame-ancestors 'none'");
  expect(check("*", false).csp).toContain("frame-ancestors *");
});
