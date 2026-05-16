export function buildCloneUrl(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

export function cloneOptionsFor(opts: { depth?: number; branch?: string }): string[] {
  const out: string[] = [];
  if (opts.depth) out.push(`--depth=${opts.depth}`);
  if (opts.branch) out.push(`--branch=${opts.branch}`);
  return out;
}

export type CloneRequest = {
  repo: string;
  token: string;
  destination: string;
  depth?: number;
  branch?: string;
};
