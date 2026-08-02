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
      firstName: "Anna Marie Van", lastName: "Merwe",
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
