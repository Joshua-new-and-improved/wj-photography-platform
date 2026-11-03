import { describe, it, expect } from "vitest";
import { parseChildFolder, childFolderFromPath } from "./childfolder.js";

describe("parsing a child's name from their folder", () => {
  it("splits the common Firstname Lastname shape", () => {
    expect(parseChildFolder("Noah Botha")).toEqual({
      firstName: "Noah", lastName: "Botha", rawFolderName: "Noah Botha",
    });
  });

  it("handles a compound given name with the surname last", () => {
    expect(parseChildFolder("Anna Marie van Merwe")).toEqual({
      firstName: "Anna Marie", lastName: "van Merwe",
      rawFolderName: "Anna Marie van Merwe",
    });
  });

  it("declines a folder name too long to plausibly be a person", () => {
    // A 5-word folder is more likely a mislabelled group than a name — this
    // is exactly the case that should fall through to manual review rather
    // than being guessed at.
    expect(parseChildFolder("Anna Marie van der Merwe")).toBeNull();
  });

  it("copes with underscores and extra spacing from a messy export", () => {
    expect(parseChildFolder("Noah_Botha")).toEqual({
      firstName: "Noah", lastName: "Botha", rawFolderName: "Noah_Botha",
    });
    expect(parseChildFolder("  Noah   Botha  ")?.firstName).toBe("Noah");
  });

  it("strips diacritics for matching but the review screen keeps the raw text", () => {
    const r = parseChildFolder("Zané Pretorius");
    expect(r?.rawFolderName).toBe("Zané Pretorius");
  });

  it("keeps accents and the photographer's capitalisation in the stored name", () => {
    expect(parseChildFolder("Zané Pretorius")).toMatchObject({ firstName: "Zané", lastName: "Pretorius" });
    expect(parseChildFolder("Zané du Toit")).toMatchObject({ firstName: "Zané", lastName: "du Toit" });
    expect(parseChildFolder("Liam le Roux")).toMatchObject({ firstName: "Liam", lastName: "le Roux" });
    expect(parseChildFolder("Mia van der Walt")).toMatchObject({ firstName: "Mia", lastName: "van der Walt" });
  });

  it("title-cases a folder typed all in one case", () => {
    expect(parseChildFolder("noah botha")).toMatchObject({ firstName: "Noah", lastName: "Botha" });
    expect(parseChildFolder("NOAH BOTHA")).toMatchObject({ firstName: "Noah", lastName: "Botha" });
    expect(parseChildFolder("anél du plessis")).toMatchObject({ firstName: "Anél", lastName: "Du Plessis" });
  });

  it("falls back to the normalised words when noise was stripped", () => {
    expect(parseChildFolder("Noah Botha (2)")).toMatchObject({ firstName: "Noah", lastName: "Botha" });
  });

  it("refuses operational folders rather than inventing a child called them", () => {
    for (const junk of ["RAW", "Originals", "_RETAKES", "Absent", "2024", "Klas A"]) {
      expect(parseChildFolder(junk)).toBeNull();
    }
  });

  it("refuses obvious junk that would never be a name", () => {
    expect(parseChildFolder(".DS_Store")).toBeNull();
    expect(parseChildFolder("")).toBeNull();
    expect(parseChildFolder("One Two Three Four Five")).toBeNull(); // too many words
  });
});

describe("locating the child folder in a path", () => {
  it("matches the standard grade/class/child layout", () => {
    const r = childFolderFromPath(["Grade R", "Class A", "Noah Botha"]);
    expect(r?.firstName).toBe("Noah");
    expect(r?.lastName).toBe("Botha");
  });

  it("does not guess at a flatter layout", () => {
    // grade/class only — no child folder. Falls through to manual tagging.
    expect(childFolderFromPath(["Grade R", "Class A"])).toBeNull();
  });

  it("does not guess at a deeper or shallower layout", () => {
    expect(childFolderFromPath(["Grade R", "Class A", "Noah", "Retakes"])).toBeNull();
    expect(childFolderFromPath(["Noah Botha"])).toBeNull();
  });
});
