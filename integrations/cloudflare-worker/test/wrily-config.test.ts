import { describe, expect, it, vi } from "vitest";
import { fetchWrilyConfig, parseWrilyYaml, DEFAULT_CONFIG } from "../src/wrily-config.js";

describe("parseWrilyYaml", () => {
  it("returns defaults for empty / missing keys", () => {
    expect(parseWrilyYaml("")).toEqual(DEFAULT_CONFIG);
    expect(parseWrilyYaml("mode: solo\n")).toEqual(DEFAULT_CONFIG);
  });

  it("reads rerequest_cooldown_minutes as integer", () => {
    expect(parseWrilyYaml("rerequest_cooldown_minutes: 5").rerequest_cooldown_minutes).toBe(5);
  });

  it("clamps negative cooldown to 0", () => {
    expect(parseWrilyYaml("rerequest_cooldown_minutes: -3").rerequest_cooldown_minutes).toBe(0);
  });

  it("falls back to default when cooldown is non-numeric", () => {
    expect(parseWrilyYaml("rerequest_cooldown_minutes: nope").rerequest_cooldown_minutes).toBe(0);
  });

  it("reads reply_feedback as on/off boolean", () => {
    expect(parseWrilyYaml("reply_feedback: off").reply_feedback).toBe(false);
    expect(parseWrilyYaml("reply_feedback: on").reply_feedback).toBe(true);
  });

  it("treats unknown reply_feedback values as default (on)", () => {
    expect(parseWrilyYaml("reply_feedback: maybe").reply_feedback).toBe(true);
  });
});

describe("fetchWrilyConfig", () => {
  it("returns defaults on 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const cfg = await fetchWrilyConfig("octo-org/example", "abc123", "TOKEN", fetchMock);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults on 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("oops", { status: 503 }));
    const cfg = await fetchWrilyConfig("octo-org/example", "abc123", "TOKEN", fetchMock);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });

  it("parses YAML on 200", async () => {
    const yaml = "rerequest_cooldown_minutes: 7\nreply_feedback: off\n";
    const fetchMock = vi.fn().mockResolvedValue(new Response(yaml, { status: 200 }));
    const cfg = await fetchWrilyConfig("octo-org/example", "abc123", "TOKEN", fetchMock);
    expect(cfg).toEqual({ rerequest_cooldown_minutes: 7, reply_feedback: false });
  });

  it("returns defaults on parse error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(" not yaml at all ", { status: 200 }));
    const cfg = await fetchWrilyConfig("octo-org/example", "abc123", "TOKEN", fetchMock);
    expect(cfg).toEqual(DEFAULT_CONFIG);
  });
});
