/*
 * Yankee Stadium section classifier + normalizer.
 *
 * Marketplaces spell the same seat a dozen ways: "Section 028", "28",
 * "Sec 28", "227b", "227B", "430 (obstructed)". Left alone these produce
 * duplicate rows and blank level badges. classify() folds any raw code to a
 * single canonical form and tags it with the seating level it belongs to, so
 * the table shows one clean row per real section ("Legends 28", "Main 227B").
 *
 * Level ranges (numeric part of the section code):
 *   Legends     1–30      premium 100-level infield / Legends Suite
 *   Field       100–136   Field Level
 *   Bleachers   201–204, 235–239
 *   Main        205–234   Main Level
 *   Terrace     300–399   Terrace Level
 *   Grandstand  400–499   Grandstand Level
 * Non-numeric codes: AUDI* = Audi Club, GA* = Standing Room, single
 * letters = Suite, anything else = Other.
 */

(function () {
  "use strict";

  // Level → sort weight, so the table can group lowest deck to highest.
  const LEVEL_ORDER = {
    Legends: 0,
    Field: 1,
    Main: 2,
    Bleachers: 3,
    "Audi Club": 4,
    Suite: 5,
    Terrace: 6,
    Grandstand: 7,
    "Standing Room": 8,
    Other: 9,
  };

  function levelFor(num, code) {
    if (num != null) {
      if (num >= 11 && num <= 30) return "Legends";     // 011–029 behind the plate
      if (num >= 1 && num <= 10) return "Suite";         // 1–4 etc. are field suites
      if (num >= 100 && num <= 136) return "Field";
      if ((num >= 201 && num <= 204) || (num >= 235 && num <= 239)) return "Bleachers";
      if (num >= 205 && num <= 234) return "Main";
      if (num >= 300 && num <= 399) return "Terrace";
      if (num >= 400 && num <= 499) return "Grandstand";
      return "Other";
    }
    if (/^AUDI/i.test(code)) return "Audi Club";
    if (/^GA/i.test(code)) return "Standing Room";
    if (/^[A-Z]{1,2}$/i.test(code)) return "Suite";
    return "Other";
  }

  // Fold a raw section string to { code, level, label, num, obstructed }.
  function classify(raw) {
    let s = String(raw == null ? "" : raw).trim();

    // Note and strip an "(obstructed)" / "obstructed view" marker.
    const obstructed = /obstruct/i.test(s);
    s = s.replace(/\(?\s*obstruct(ed)?(\s*view)?\s*\)?/gi, "").trim();

    // Drop a leading "Section" / "Sec" label.
    s = s.replace(/^sec(tion)?\.?\s*/i, "").trim();
    s = s.toUpperCase().replace(/\s+/g, "");

    // Numeric section, optionally with a letter suffix (227B, 305W, 407A).
    let num = null;
    let code = s;
    const m = s.match(/^0*(\d+)([A-Z]*)$/);
    if (m) {
      num = parseInt(m[1], 10);
      code = m[1] + m[2]; // leading zeros stripped, suffix kept
    }

    const level = levelFor(num, code);

    // Display code: Legends sections are labelled with a leading zero at the
    // stadium (011–029), so show them padded to three digits. `code` stays the
    // stripped form ("28") for dedup and for matching the scraper's keys.
    let display = code;
    if (level === "Legends" && num != null) {
      const suffix = m ? m[2] : "";
      display = String(num).padStart(3, "0") + suffix;
    }

    let label = display ? level + " " + display : level;
    if (obstructed) label += " (obstructed)";

    return { code, display, level, label, num, obstructed };
  }

  // Comparator for two classified sections: by level, then numeric, then code.
  function compare(a, b) {
    const la = LEVEL_ORDER[a.level] ?? 99;
    const lb = LEVEL_ORDER[b.level] ?? 99;
    if (la !== lb) return la - lb;
    if (a.num != null && b.num != null && a.num !== b.num) return a.num - b.num;
    if (a.num != null && b.num == null) return -1;
    if (a.num == null && b.num != null) return 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  }

  window.Sections = { classify, compare, LEVEL_ORDER };
})();
