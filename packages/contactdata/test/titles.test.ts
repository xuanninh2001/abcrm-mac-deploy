import { describe, expect, it } from "vitest";
import { matchTitle, seniorityOf, titleGroups } from "../src/index.js";

const synonyms = {
  affiliate_manager: ["affiliate mgr", "affiliate partnerships manager", "publisher manager", "vendor manager"],
  partnerships_director: ["director, partnerships", "head of partnerships"],
};
const groups = titleGroups(["Affiliate Manager", "Director of Partnerships", "Head of Media Buying"], synonyms);

describe("title matching", () => {
  it.each([
    ["Affiliate Manager", "exact"],
    ["Senior Affiliate Manager", "exact"],
    ["Affiliate Mgr", "exact"],
    ["Publisher Manager", "exact"],
    ["Head of Partnerships", "exact"],
    ["Partnerships Director", "exact"],
    ["Affiliate Manager, Insurance Vertical", "close"],
    ["Media Buying Head - Health", "close"],
    ["Partner Marketing Specialist", "weak"],
    ["Software Engineer", "none"],
    ["", "none"],
  ])("%s → %s", (title, expected) => {
    expect(matchTitle(title, groups)).toBe(expected);
  });

  it("infers seniority", () => {
    expect(seniorityOf("VP Growth")).toBe("vp");
    expect(seniorityOf("Vice President, Partnerships")).toBe("vp");
    expect(seniorityOf("Co-Founder & CEO")).toBe("owner");
    expect(seniorityOf("Chief Marketing Officer")).toBe("c_level");
    expect(seniorityOf("Head of Partnerships")).toBe("director");
    expect(seniorityOf("Affiliate Mgr")).toBe("manager");
    expect(seniorityOf("Analyst")).toBe("ic");
  });
});
