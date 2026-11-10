import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { applyMapping, decodeText, detectDelimiter, parseCsvBuffer, parseFile, proposeMapping, validateRow } from "../src/index.js";

describe("parsing", () => {
  it("handles BOM, semicolons, quotes and Windows-1252", () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Company;Website;Email\n"Acme; Inc";acme.com;jane@acme.com\n')]);
    const s = parseCsvBuffer(utf8);
    expect(s.headers).toEqual(["Company", "Website", "Email"]);
    expect(s.rows[0]).toEqual({ Company: "Acme; Inc", Website: "acme.com", Email: "jane@acme.com" });
    expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");   // not valid UTF-8 → cp1252
    expect(detectDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("dedupes header names and skips blank rows", () => {
    const s = parseCsvBuffer(Buffer.from("Email,Email,\nx@a.com,y@a.com,\n,,\n"));
    expect(s.headers).toEqual(["Email", "Email (2)", "column_3"]);
    expect(s.rows).toHaveLength(1);
  });

  it("reads xlsx workbooks with multiple sheets, hyperlinks and dates", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Buyers");
    ws.addRow(["Company", "Website", "Added"]);
    ws.addRow(["Acme", { text: "acme.com", hyperlink: "https://acme.com" }, new Date("2026-10-01T00:00:00Z")]);
    wb.addWorksheet("Blocklist").addRow(["Domain"]);
    wb.getWorksheet("Blocklist")!.addRow(["rival.com"]);
    const sheets = await parseFile(Buffer.from(await wb.xlsx.writeBuffer()), "buyers.xlsx");
    expect(sheets.map((x) => x.name)).toEqual(["Buyers", "Blocklist"]);
    expect(sheets[0]!.rows[0]).toEqual({ Company: "Acme", Website: "acme.com", Added: "2026-10-01" });
  });

  it("rejects unsupported types", async () => {
    await expect(parseFile(Buffer.from("x"), "a.pdf")).rejects.toThrow(/Unsupported/);
  });
});

describe("mapping & validation", () => {
  it("proposes mappings for Apollo-style contact exports", () => {
    const m = proposeMapping(["First Name", "Last Name", "Title", "Company", "Email", "Person Linkedin Url", "Website", "Company State"], "contacts");
    expect(Object.fromEntries(m.map((x) => [x.source, x.target]))).toEqual({
      "First Name": "first_name", "Last Name": "last_name", Title: "title", Company: "company_name", Email: "email",
      "Person Linkedin Url": "linkedin_url", Website: "company_domain", "Company State": "hq_state",
    });
  });

  it("derives company domain from work email; rejects personal mailboxes", () => {
    const work = validateRow("contacts", { email: "Jane@AcmeHealth.com", first_name: "Jane" });
    expect(work).toMatchObject({ status: "warning", normalized: { company_domain: "acmehealth.com", email: "jane@acmehealth.com" } });
    expect(validateRow("contacts", { email: "jane@gmail.com", first_name: "Jane" }).status).toBe("error");
    expect(validateRow("contacts", { email: "jane@gmail.com", company_domain: "acme.com" }).status).toBe("valid");
  });

  it("splits full names, normalizes states, ignores non-LinkedIn URLs", () => {
    const r = validateRow("contacts", applyMapping({ n: "Mary Ann Lee", d: "www.acme.com", s: "fl", l: "https://evil.example/x" },
      [{ source: "n", target: "full_name", confidence: 1 }, { source: "d", target: "company_domain", confidence: 1 },
       { source: "s", target: "hq_state", confidence: 1 }, { source: "l", target: "linkedin_url", confidence: 1 }]));
    expect(r.normalized).toMatchObject({ first_name: "Mary", last_name: "Ann Lee", company_domain: "acme.com", hq_state: "FL" });
    expect(r.normalized.linkedin_url).toBeUndefined();
    expect(r.status).toBe("warning");
  });

  it("blocklist accepts emails or domains", () => {
    expect(validateRow("blocklist", { value: "STOP@Rival.com" }).normalized.value).toBe("stop@rival.com");
    expect(validateRow("blocklist", { value: "https://www.rival.com" }).normalized.value).toBe("rival.com");
    expect(validateRow("blocklist", { value: "nonsense" }).status).toBe("error");
  });
});
