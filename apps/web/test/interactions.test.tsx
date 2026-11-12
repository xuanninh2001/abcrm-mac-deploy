// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeedbackProvider } from "../src/components/FeedbackProvider";
import { Action } from "../src/components/Action";
import { RoleSelect } from "../src/components/RoleSelect";
import { NewRun } from "../src/components/NewRun";
import { AppShell } from "../src/components/AppShell";

const { call, refresh } = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/client", () => ({ call, errorText: (e: Error) => e.message }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/inbox" }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe("safe asynchronous interactions", () => {
  it("opens an accessible navigation dialog and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<AppShell name="Pat" role="viewer" unread={0}><p>Workspace</p></AppShell>);
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Workspace navigation" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.querySelector('a[href="/imports"]')).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
  it("focuses Cancel, cancels without a request, then confirms exactly once", async () => {
    const user = userEvent.setup();
    let finish!: (value: object) => void;
    call.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<FeedbackProvider><Action path="/example" confirm="Remove this item?">Remove</Action></FeedbackProvider>);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(call).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove" })));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Confirm", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(true);
    await act(async () => finish({}));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the failure inline and allows retry", async () => {
    call.mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce({});
    render(<FeedbackProvider><Action path="/example">Save</Action></FeedbackProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("Permission denied");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(call).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the current role when owner confirmation is cancelled or update fails", async () => {
    const user = userEvent.setup();
    render(<FeedbackProvider><RoleSelect userId="1" role="viewer" label="Pat" allowOwner /></FeedbackProvider>);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, "owner");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(select.value).toBe("viewer");
    expect(call).not.toHaveBeenCalled();
    call.mockRejectedValueOnce(new Error("Update failed"));
    await user.selectOptions(select, "admin");
    expect(select.value).toBe("viewer");
    expect(screen.getByRole("alert").textContent).toContain("Update failed");
  });

  it("ignores stale estimates and blocks invalid target counts", async () => {
    let oldEstimate!: (value: unknown) => void;
    call.mockImplementationOnce(() => new Promise(resolve => { oldEstimate = resolve; }))
      .mockResolvedValue({ agent_credits: 20, contact_credits: 40, requires_approval: false });
    render(<NewRun ipps={[{ id: "ipp", name: "Active IPP" }]} />);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "200" } });
    await waitFor(() => expect(screen.getByText(/20 agent credits/)).toBeTruthy());
    await act(async () => oldEstimate({ agent_credits: 999, contact_credits: 999, requires_approval: true }));
    expect(screen.queryByText(/999 agent credits/)).toBeNull();
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Start run" }).hasAttribute("disabled")).toBe(true);
  });
});
