// Loads .wrily.yml from the consumer repo at a given commit SHA.
// Defaults (rerequest_cooldown_minutes=0, reply_feedback=on) are returned for
// any failure mode: 404, 5xx, parse error. Per spec §Error Handling we never
// surface YAML errors to the comment author.

export interface WrilyConfig {
  rerequest_cooldown_minutes: number;
  reply_feedback: boolean;
}

export const DEFAULT_CONFIG: WrilyConfig = {
  rerequest_cooldown_minutes: 0,
  reply_feedback: true,
};

export function parseWrilyYaml(text: string): WrilyConfig {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/#.*$/, "").trim();
      if (!line) continue;
      const m = /^([a-z_]+)\s*:\s*(.+?)\s*$/i.exec(line);
      if (!m) continue;
      const key = m[1]!;
      const value = m[2]!.replace(/^["']|["']$/g, "");
      if (key === "rerequest_cooldown_minutes") {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) cfg.rerequest_cooldown_minutes = Math.max(0, n);
      } else if (key === "reply_feedback") {
        const lc = value.toLowerCase();
        if (lc === "off" || lc === "false" || lc === "no") cfg.reply_feedback = false;
        else if (lc === "on" || lc === "true" || lc === "yes") cfg.reply_feedback = true;
      }
    }
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return cfg;
}

export async function fetchWrilyConfig(
  consumerRepo: string,
  ref: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WrilyConfig> {
  try {
    const url = `https://api.github.com/repos/${consumerRepo}/contents/.wrily.yml?ref=${encodeURIComponent(ref)}`;
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/vnd.github.raw",
        authorization: `Bearer ${token}`,
        "user-agent": "wrily-review-dispatcher",
      },
    });
    if (res.status !== 200) return { ...DEFAULT_CONFIG };
    const text = await res.text();
    return parseWrilyYaml(text);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
