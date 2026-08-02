import { describe, it, expect } from "vitest";
import {
  normaliseFolderName,
  isIgnorableName,
  parseGrade,
  parseClass,
  parseCombined,
  similarity,
  bestMatch,
  proposeStructure,
} from "./folders.js";

describe("normalisation", () => {
  it("strips diacritics, case, and punctuation", () => {
    expect(normaliseFolderName("Graad-R")).toBe("graad r");
    expect(normaliseFolderName("KLAS_A")).toBe("klas a");
    expect(normaliseFolderName("Sonnetjies")).toBe("sonnetjies");
  });

  it("drops the teacher's name in brackets", () => {
    // Teachers change; the class does not. `Grade R (Ms Botha)` next year
    // becomes `Grade R (Mr Naidoo)` and must still match the same class.
    expect(normaliseFolderName("Grade R (Ms Botha)")).toBe("grade r");
  });

  it("drops editing detritus", () => {
    expect(normaliseFolderName("Graad 1 FINAL v2")).toBe("graad 1");
    expect(normaliseFolderName("Klas B kopie")).toBe("klas b");
    expect(normaliseFolderName("Grade 2 (1)")).toBe("grade 2");
  });
});

describe("ignorable folders", () => {
  it("recognises the junk that ships with every real upload", () => {
    for (const junk of ["__MACOSX", ".DS_Store", "Thumbs.db", "Originals", "RAW", "temp"]) {
      expect(isIgnorableName(junk)).toBe(true);
    }
    expect(isIgnorableName("Graad R")).toBe(false);
  });
});

describe("grade parsing", () => {
  it("handles Afrikaans and English equally", () => {
    for (const raw of ["Grade 3", "Graad 3", "Gr 3", "gr3", "G3", "graad-3"]) {
      expect(parseGrade(raw)?.level).toBe("3");
    }
  });

  it("handles the reception year in every form it appears", () => {
    for (const raw of ["Grade R", "Graad R", "GrR", "R", "Reception", "Rec"]) {
      expect(parseGrade(raw)?.level).toBe("R");
    }
  });

  it("does not confuse Grade RR with Grade R", () => {
    // Getting this wrong merges two entire year groups.
    expect(parseGrade("Graad RR")?.level).toBe("RR");
    expect(parseGrade("GrRR")?.level).toBe("RR");
    expect(parseGrade("Grade R")?.level).toBe("R");
  });

  it("flags a bare number as less certain than a worded grade", () => {
    expect(parseGrade("Grade 4")!.confidence).toBe(1);
    // A folder called `4` could be a class, a session, or a camera batch.
    expect(parseGrade("4")!.confidence).toBeLessThan(1);
  });

  it("returns null rather than guessing", () => {
    // The single most important behaviour here. `_RETAKES` is not grade zero.
    expect(parseGrade("_RETAKES")).toBeNull();
    expect(parseGrade("Absentees")).toBeNull();
    expect(parseGrade("Grade 13")).toBeNull();
  });
});

describe("class parsing", () => {
  it("handles worded and bare labels", () => {
    expect(parseClass("Klas A")?.name).toBe("A");
    expect(parseClass("Class A")?.name).toBe("A");
    expect(parseClass("A")?.name).toBe("A");
  });

  it("keeps crèche colour and nature names verbatim", () => {
    // Afrikaans pre-schools name classes Blou, Rooi, Sonnetjies rather than A/B.
    expect(parseClass("Blou")?.name).toBe("Blou");
    expect(parseClass("Sonnetjies")?.name).toBe("Sonnetjies");
    expect(parseClass("Blou")!.confidence).toBeLessThan(0.95);
  });
});

describe("flattened folders", () => {
  it("splits a level that carries both grade and class", () => {
    const r = parseCombined("Graad R - A");
    expect(r?.grade.level).toBe("R");
    expect(r?.klass.name).toBe("A");

    const r2 = parseCombined("Gr 1 Klas B");
    expect(r2?.grade.level).toBe("1");
    expect(r2?.klass.name).toBe("B");
  });
});

describe("fuzzy matching", () => {
  const existing = [{ name: "Grade R A" }, { name: "Grade R B" }, { name: "Grade 1 A" }];

  it("matches an Afrikaans variant to its existing English record", () => {
    const m = bestMatch("Graad R A", existing, (c) => c.name);
    expect(m?.candidate.name).toBe("Grade R A");
  });

  it("does NOT match across year groups", () => {
    // `Grade 2 A` finding `Grade 1 A` would silently mix two year groups —
    // the exact failure the review step exists to prevent.
    const m = bestMatch("Grade 2 A", existing, (c) => c.name);
    expect(m?.candidate.name).not.toBe("Grade 1 A");
  });

  it("scores identical names at 1", () => {
    expect(similarity("Grade R A", "grade-r-a")).toBe(1);
  });
});

describe("structure proposal", () => {
  const f = (relativePath: string) => ({ relativePath, size: 1000 });

  it("parses the documented three-level layout cleanly", () => {
    const p = proposeStructure([
      f("Laerskool Alfa/Graad R/Klas A/IMG_001.jpg"),
      f("Laerskool Alfa/Graad R/Klas A/IMG_002.jpg"),
      f("Laerskool Alfa/Graad R/Klas B/IMG_003.jpg"),
      f("Laerskool Alfa/Graad 1/Klas A/IMG_004.jpg"),
    ]);

    expect(p.schoolName).toBe("Laerskool Alfa");
    expect(p.fileCount).toBe(4);
    expect(p.grades.map((g) => g.canonical)).toEqual(["Grade R", "Grade 1"]);
    expect(p.grades[0]!.classes.map((c) => c.canonical)).toEqual(["A", "B"]);
    expect(p.grades[0]!.classes[0]!.fileCount).toBe(2);
    // The one-click case.
    expect(p.cleanParse).toBe(true);
  });

  it("sorts grades numerically, not lexically", () => {
    const p = proposeStructure([
      f("S/Graad 10/A/a.jpg"),
      f("S/Graad 2/A/b.jpg"),
      f("S/Graad R/A/c.jpg"),
      f("S/Graad RR/A/d.jpg"),
    ]);
    // String sorting would put Grade 10 before Grade 2.
    expect(p.grades.map((g) => g.canonical)).toEqual([
      "Grade RR",
      "Grade R",
      "Grade 2",
      "Grade 10",
    ]);
  });

  it("ignores system junk without counting it", () => {
    const p = proposeStructure([
      f("S/Graad R/Klas A/IMG_001.jpg"),
      f("S/Graad R/Klas A/.DS_Store"),
      f("__MACOSX/S/Graad R/Klas A/._IMG_001.jpg"),
      f("S/Originals/Graad R/IMG_099.jpg"),
    ]);
    expect(p.fileCount).toBe(1);
    expect(p.ignored).toHaveLength(3);
  });

  it("surfaces unrecognised folders instead of guessing", () => {
    const p = proposeStructure([
      f("S/Graad R/Klas A/IMG_001.jpg"),
      f("S/_RETAKES/IMG_500.jpg"),
    ]);
    expect(p.unplaced).toHaveLength(1);
    expect(p.unplaced[0]!.reason).toBe("unrecognised_folder");
    // Anything unplaced means the photographer must look before committing.
    expect(p.cleanParse).toBe(false);
  });

  it("handles the flattened layout and flags it", () => {
    const p = proposeStructure([
      f("S/Graad R - A/IMG_001.jpg"),
      f("S/Graad R - B/IMG_002.jpg"),
    ]);
    expect(p.grades).toHaveLength(1);
    expect(p.grades[0]!.classes.map((c) => c.canonical)).toEqual(["A", "B"]);
    expect(p.grades[0]!.classes[0]!.issues).toContain("flat_structure");
    expect(p.cleanParse).toBe(false);
  });

  it("handles a crèche with no grade tier, at low confidence", () => {
    const p = proposeStructure([
      f("Sonskyn Kleuterskool/Blou/IMG_001.jpg"),
      f("Sonskyn Kleuterskool/Rooi/IMG_002.jpg"),
    ]);
    expect(p.grades).toHaveLength(1);
    expect(p.grades[0]!.classes.map((c) => c.canonical).sort()).toEqual(["Blou", "Rooi"]);
    expect(p.grades[0]!.classes[0]!.issues).toContain("no_grade_found");
    expect(p.cleanParse).toBe(false);
  });

  it("scales to a whole school without drama", () => {
    const files = [];
    for (const g of ["Graad R", "Graad 1", "Graad 2", "Graad 3"]) {
      for (const c of ["Klas A", "Klas B"]) {
        for (let i = 0; i < 150; i++) {
          files.push(f(`Laerskool Alfa/${g}/${c}/IMG_${i}.jpg`));
        }
      }
    }
    const p = proposeStructure(files);
    expect(p.fileCount).toBe(1200);
    expect(p.grades).toHaveLength(4);
    expect(p.cleanParse).toBe(true);
  });
});
