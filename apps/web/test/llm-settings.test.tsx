// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LlmSettings, type LlmConfig } from "../src/components/LlmSettings";

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/client", () => ({ call, errorText: (error: Error) => error.message }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
const initial: LlmConfig = { mode: "9router", baseUrl: "https://router.example.com/v1", model: "cc/model", hasApiKey: true,
  jsonMode: false, inputPrice: 0, outputPrice: 0, updatedAt: null };
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
it("never renders a saved key, keeps it on save and clears newly entered key after success", async () => {
  const user = userEvent.setup();
  call.mockResolvedValue(initial);
  render(<LlmSettings initial={initial} />);
  const key = screen.getByLabelText("9router API key") as HTMLInputElement;
  expect(key.value).toBe(""); expect(key.type).toBe("password");
  await user.click(screen.getByRole("button", { name: "Save configuration" }));
  expect(call.mock.calls[0]![1].body.apiKey).toBeUndefined();
  await user.type(key, "replacement-secret");
  await user.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(key.value).toBe(""));
  expect(screen.getByRole("status").textContent).toContain("Saved");
});
it("loads models and tests without saving, and displays actionable errors", async () => {
  const user = userEvent.setup();
  call.mockResolvedValueOnce({ models: ["cc/model", "my-combo"] }).mockRejectedValueOnce(new Error("9router HTTP 401. Check API key."));
  render(<LlmSettings initial={initial} />);
  await user.click(screen.getByRole("button", { name: "Load models" }));
  expect(call.mock.calls[0]![0]).toBe("/llm-settings/models");
  expect(document.querySelector('option[value="my-combo"]')).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  expect(screen.getByRole("alert").textContent).toContain("401");
  expect(call.mock.calls.map(c => c[0])).not.toContain("/llm-settings");
});
