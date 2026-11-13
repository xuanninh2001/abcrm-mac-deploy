// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SourceSettings, type SourcesData } from "../src/components/SourceSettings";
const {call}=vi.hoisted(()=>({call:vi.fn()}));
vi.mock("@/lib/client",()=>({call,errorText:(e:Error)=>e.message}));
vi.mock("sonner",()=>({toast:{success:vi.fn()}}));
const initial:SourcesData={environmentFallback:false,sources:[{provider:"brave",kind:"search",name:"Brave Search",configured:true,enabled:true,priority:1,hasApiKey:true,usageAllowed:false}]};
afterEach(cleanup); beforeEach(()=>vi.clearAllMocks());
it("keeps stored key hidden and saves disabled state without deleting key",async()=>{
  const user=userEvent.setup();call.mockResolvedValue({ ...initial,sources:[{...initial.sources[0],enabled:false}] });
  render(<SourceSettings initial={initial}/>);
  const form=within(screen.getByRole("form",{name:"Brave Search"}));
  expect((form.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  await user.click(form.getByRole("checkbox",{name:"Enable Brave Search"}));
  await user.click(form.getByRole("button",{name:"Save source"}));
  expect(call.mock.calls[0]![1]).toMatchObject({method:"PUT",body:{enabled:false,clearKey:false}});
  expect(call.mock.calls[0]![1].body.apiKey).toBeUndefined();
  expect(form.getByRole("status").textContent).toContain("disabled");
});
it("tests without saving and exposes provider errors beside the source",async()=>{
  call.mockRejectedValue(new Error("Brave HTTP 401. Check API key, plan and quota."));
  render(<SourceSettings initial={initial}/>);
  await userEvent.click(screen.getByRole("button",{name:"Test connection"}));
  expect(call.mock.calls[0]![0]).toBe("/sources/brave/test");
  expect(screen.getByRole("alert").textContent).toContain("401");
  expect(call).toHaveBeenCalledTimes(1);
});
