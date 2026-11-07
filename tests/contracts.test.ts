import { describe, expect, it } from "vitest";
import { botColor, createBotSchema, createConversationSchema, DEFAULT_MODEL } from "@slopbot/contracts";

describe("shared product contracts", () => {
  it("applies the gateway default and validates a bot", () => {
    const bot = createBotSchema.parse({ name: "Nova", handle: "nova", persona: "A concise and helpful product strategist.", integrationIds: [] });
    expect(bot.model).toBe(DEFAULT_MODEL);
  });

  it("bounds a group to four unique participants at the API boundary", () => {
    const input = { title: "Council", botIds: ["a", "b", "c", "d"] };
    expect(createConversationSchema.parse(input).botIds).toHaveLength(4);
    expect(() => createConversationSchema.parse({ ...input, botIds: [...input.botIds, "e"] })).toThrow();
  });

  it("rejects unsafe or ambiguous handles", () => {
    expect(() => createBotSchema.parse({ name: "Bad", handle: "1 bad!", persona: "Long enough persona.", integrationIds: [] })).toThrow();
  });

  it("uses deterministic avatar colors", () => {
    expect(botColor("same-id")).toBe(botColor("same-id"));
  });
});
