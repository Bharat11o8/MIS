/**
 * The colour contract for the OE Network module.
 *
 * These are not aesthetic assertions — each one pins down a rule that was
 * actually broken in the module and caused a misreading. They exist so the next
 * person to add a StatCard or a chart series gets a failing test instead of a
 * plausible-looking screen.
 */
import { describe, it, expect } from "vitest";
import {
  KPI, VISIT_COLOR, CALL_COLOR, UNOWNED_COLOR, TGT_TRACK, NEUTRAL_BAR,
  FUNNEL_MISSED, CHART_LABEL, coverageColor,
} from "./shared";

const hex = /^#[0-9a-f]{6}$/i;

describe("KPI colour roles", () => {
  it("every role is a well-formed colour pair", () => {
    for (const [role, v] of Object.entries(KPI)) {
      expect(v.color, `${role}.color`).toMatch(hex);
      expect(v.bg, `${role}.bg`).toMatch(hex);
      expect(v.color, `${role} must not be its own background`).not.toBe(v.bg);
    }
  });

  it("uses the brand orange, never Tailwind's orange-500", () => {
    // #f97316 is Tailwind orange-500. The two sat side by side for months and
    // read as a rendering bug.
    expect(KPI.ours.color).toBe(VISIT_COLOR);
    expect(KPI.ours.color).toBe("#f46617");
    for (const v of Object.values(KPI)) expect(v.color).not.toBe("#f97316");
  });

  it("keeps visits orange and calls blue, the app-wide entity colours", () => {
    expect(KPI.visits.color).toBe(VISIT_COLOR);
    expect(KPI.calls.color).toBe(CALL_COLOR);
  });

  it("never gives a person the unowned-target purple", () => {
    // UNOWNED_COLOR means "a target belonging to no salesperson" on the bullet
    // charts. A headcount tile in that colour reads as exactly the thing it is
    // defined not to be.
    expect(KPI.target.color).toBe(UNOWNED_COLOR);
    expect(KPI.neutral.color).not.toBe(UNOWNED_COLOR);
    expect(KPI.reach.color).not.toBe(UNOWNED_COLOR);
    expect(KPI.activity.color).not.toBe(UNOWNED_COLOR);
  });

  it("gives good/bad/attention three distinct colours", () => {
    const { conversion, warning, danger } = KPI;
    expect(new Set([conversion.color, warning.color, danger.color]).size).toBe(3);
  });

  it("has exactly one green and one grey, not two of each", () => {
    // The drift this catches: #22c55e on some cards and #16a34a on others,
    // neutral grey with #f9fafb on one tab and #f3f4f6 on another.
    const greens = Object.values(KPI).filter((v) => v.bg === "#f0fdf4");
    expect(new Set(greens.map((v) => v.color)).size).toBe(1);
    const greys = Object.values(KPI).filter((v) => v.color === "#6b7280");
    expect(new Set(greys.map((v) => v.bg)).size).toBe(1);
  });
});

describe("chart palette", () => {
  it("separates the three funnel bands from each other", () => {
    // Stacked directly on top of one another, so they must differ from the
    // NEIGHBOUR, not just from the white card. NEUTRAL_BAR over TGT_TRACK read
    // as one grey block, which is why FUNNEL_MISSED exists.
    const bands = [VISIT_COLOR, FUNNEL_MISSED, TGT_TRACK];
    expect(new Set(bands).size).toBe(3);
    expect(FUNNEL_MISSED).not.toBe(NEUTRAL_BAR);
    expect(FUNNEL_MISSED).not.toBe(TGT_TRACK);
  });

  it("keeps chart label text off every series colour", () => {
    // Recharts draws legend/tooltip text in the series colour by default, which
    // makes the pale series unreadable. Labels stay dark.
    for (const series of [VISIT_COLOR, CALL_COLOR, TGT_TRACK, NEUTRAL_BAR, FUNNEL_MISSED]) {
      expect(CHART_LABEL).not.toBe(series);
    }
  });
});

describe("coverageColor", () => {
  it("greys out missing data rather than colouring it bad", () => {
    // Absent is not failure. A null coverage rendered red is a lie.
    // Asserted as the RULE, not an exact shade, so tuning the grey scale for
    // contrast doesn't break a test about meaning.
    const c = coverageColor(null);
    expect(c).toMatch(/^text-gray-\d{3}$/);
    expect(c).not.toMatch(/red|green|amber|orange/);
  });

  it("uses a grey dark enough to read for missing data", () => {
    // gray-300 is 1.5:1 on white and gray-400 is 2.5:1 — both below the 4.5:1
    // AA floor. Anything a user is meant to READ starts at gray-500.
    expect(coverageColor(null)).not.toMatch(/gray-(100|200|300|400)$/);
  });

  it("banks at 80 and 50", () => {
    expect(coverageColor(100)).toBe("text-green-600");
    expect(coverageColor(80)).toBe("text-green-600");
    expect(coverageColor(79.9)).toBe("text-amber-600");
    expect(coverageColor(50)).toBe("text-amber-600");
    expect(coverageColor(49.9)).toBe("text-red-500");
    expect(coverageColor(0)).toBe("text-red-500");
  });
});
