import { describe, expect, it } from "vitest";
import { botColor, createBotSchema, createConversationSchema, DEFAULT_MODEL } from "@slopbot/contracts";

describe("shared product contracts", () => {
  it("applies the gateway default and validates a bot", () => {
    const bot = createBotSchema.parse({ name: "Nova", handle: "nova", persona: "A concise and helpful product strategist.", integrationIds: [] });
    expect(bot.model).toBe(DEFAULT_MODEL);
  });

  it("requires exactly one bot per chat at the API boundary", () => {
    expect(createConversationSchema.parse({ title: "Nova", botIds: ["a"] }).botIds).toEqual(["a"]);
    expect(() => createConversationSchema.parse({ title: "Council", botIds: ["a", "b"] })).toThrow();
    expect(() => createConversationSchema.parse({ title: "Empty", botIds: [] })).toThrow();
  });

  it("rejects unsafe or ambiguous handles", () => {
    expect(() => createBotSchema.parse({ name: "Bad", handle: "1 bad!", persona: "Long enough persona.", integrationIds: [] })).toThrow();
  });

  it("uses deterministic avatar colors", () => {
    expect(botColor("same-id")).toBe(botColor("same-id"));
  });
});
