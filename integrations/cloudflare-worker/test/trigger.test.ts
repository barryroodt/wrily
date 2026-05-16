import { describe, expect, it } from "vitest";
import { parseTrigger } from "../src/trigger.js";

describe("parseTrigger", () => {
  it("returns null for body without trigger", () => {
    expect(parseTrigger("LGTM")).toBeNull();
    expect(parseTrigger("")).toBeNull();
  });

  it("matches bare /wrily review on its own line → delta", () => {
    expect(parseTrigger("/wrily review")).toEqual({ scope_override: "delta" });
  });

  it("matches @wrily review → delta", () => {
    expect(parseTrigger("@wrily review")).toEqual({ scope_override: "delta" });
  });

  it("matches /wrily review full → full", () => {
    expect(parseTrigger("/wrily review full")).toEqual({ scope_override: "full" });
  });

  it("matches across multi-line body", () => {
    expect(parseTrigger("hey team\n\n/wrily review\n\nthanks")).toEqual({
      scope_override: "delta",
    });
  });

  it("is case-insensitive on command + arg", () => {
    expect(parseTrigger("/WRILY Review FULL")).toEqual({ scope_override: "full" });
  });

  it("tolerates leading whitespace on the trigger line", () => {
    expect(parseTrigger("  /wrily review  ")).toEqual({ scope_override: "delta" });
  });

  it("rejects trigger embedded in prose", () => {
    expect(parseTrigger("please run /wrily review when you can")).toBeNull();
  });

  it("rejects trigger on a line beginning with > blockquote marker", () => {
    expect(parseTrigger("> /wrily review")).toBeNull();
    expect(parseTrigger("  >  /wrily review")).toBeNull();
  });

  it("rejects trigger inside a fenced code block (```)", () => {
    const body = "Try this:\n```\n/wrily review\n```\nthanks";
    expect(parseTrigger(body)).toBeNull();
  });

  it("rejects trigger inside a tilde fenced code block (~~~)", () => {
    const body = "~~~\n/wrily review full\n~~~";
    expect(parseTrigger(body)).toBeNull();
  });

  it("accepts trigger after a closed fenced block", () => {
    const body = "```\nsome code\n```\n/wrily review";
    expect(parseTrigger(body)).toEqual({ scope_override: "delta" });
  });

  it("rejects unknown trailing args", () => {
    expect(parseTrigger("/wrily review delta")).toBeNull();
    expect(parseTrigger("/wrily review --full")).toBeNull();
    expect(parseTrigger("/wrily reviewfull")).toBeNull();
  });

  it("rejects /wrily without review verb", () => {
    expect(parseTrigger("/wrily")).toBeNull();
    expect(parseTrigger("/wrily please")).toBeNull();
  });

  it("treats ~~~ as a non-closer for a ```-opened fence", () => {
    // GFM requires the closing fence to match the opener; without that, a mixed
    // pair would corrupt the inFence flag and silently drop the real trigger.
    const body = "```\n/wrily review\n~~~\n/wrily review full";
    expect(parseTrigger(body)).toBeNull();
  });

  it("treats ``` as a non-closer for a ~~~-opened fence", () => {
    const body = "~~~\n/wrily review\n```\n/wrily review";
    expect(parseTrigger(body)).toBeNull();
  });

  it("accepts trigger after a ```-opened fence properly closed by ```", () => {
    const body = "```\nsome code\n```\n/wrily review";
    expect(parseTrigger(body)).toEqual({ scope_override: "delta" });
  });
});
