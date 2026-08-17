/**
 * Period-selection logic for the OE Network tabs.
 *
 * All four tabs now share these functions, so a bug here is a bug on every tab
 * at once. The cases worth pinning down are the Indian financial year (Apr–Mar)
 * and its Q4, which is the one quarter that spans two calendar years — the
 * place every off-by-one in this file has come from.
 */
import { describe, it, expect } from "vitest";
import {
  fyOf, fqOf, quarterToken, quarterLabel, fyLabel, monthToken, tokenLabel,
  periodRange, periodParams, buildPeriodOptions, periodMonthBounds, monthInBounds,
  type Period,
} from "./shared";

describe("Indian financial year", () => {
  it("starts in April", () => {
    expect(fyOf(2026, 4)).toBe(2026);   // Apr 2026 → FY26-27
    expect(fyOf(2026, 3)).toBe(2025);   // Mar 2026 → still FY25-26
    expect(fyOf(2026, 12)).toBe(2026);
    expect(fyOf(2026, 1)).toBe(2025);
  });

  it("numbers quarters from April", () => {
    expect(fqOf(4)).toBe(1);            // Apr–Jun
    expect(fqOf(6)).toBe(1);
    expect(fqOf(7)).toBe(2);            // Jul–Sep
    expect(fqOf(9)).toBe(2);
    expect(fqOf(10)).toBe(3);           // Oct–Dec
    expect(fqOf(12)).toBe(3);
    expect(fqOf(1)).toBe(4);            // Jan–Mar, the year-spanning one
    expect(fqOf(3)).toBe(4);
  });

  it("labels an FY by both calendar years", () => {
    expect(fyLabel(2026)).toBe("FY26-27");
    expect(quarterLabel(quarterToken(2026, 1))).toBe("Q1 FY27");
  });
});

describe("periodRange", () => {
  it("expands a month to itself, zero-padded", () => {
    expect(periodRange("monthly", "2026-8")).toEqual(["2026-08", "2026-08"]);
    expect(periodRange("monthly", "2026-12")).toEqual(["2026-12", "2026-12"]);
  });

  it("expands Q1–Q3 inside one calendar year", () => {
    expect(periodRange("quarterly", "2026-Q1")).toEqual(["2026-04", "2026-06"]);
    expect(periodRange("quarterly", "2026-Q2")).toEqual(["2026-07", "2026-09"]);
    expect(periodRange("quarterly", "2026-Q3")).toEqual(["2026-10", "2026-12"]);
  });

  it("rolls Q4 into the NEXT calendar year", () => {
    // FY26-27 Q4 is Jan–Mar 2027, not Jan–Mar 2026. Getting this wrong reads a
    // whole year early and the numbers look plausible, which is the danger.
    expect(periodRange("quarterly", "2026-Q4")).toEqual(["2027-01", "2027-03"]);
  });

  it("expands an FY across the year boundary", () => {
    expect(periodRange("yearly", "2026")).toEqual(["2026-04", "2027-03"]);
  });
});

describe("periodParams", () => {
  const noRange = { from: "", to: "" };

  it("sends nothing at all for all-time", () => {
    expect(periodParams("all", "", noRange)).toEqual({});
  });

  it("sends exact dates for a complete custom range", () => {
    expect(periodParams("custom", "", { from: "2026-04-15", to: "2026-06-02" }))
      .toEqual({ from_date: "2026-04-15", to_date: "2026-06-02" });
  });

  it("refuses to fire on a half-entered custom range", () => {
    // null means "not a usable question yet". Returning {} here would silently
    // request EVERYTHING while the user is mid-way through picking dates.
    expect(periodParams("custom", "", { from: "2026-04-15", to: "" })).toBeNull();
    expect(periodParams("custom", "", { from: "", to: "2026-06-02" })).toBeNull();
  });

  it("refuses to fire before a preset token is chosen", () => {
    expect(periodParams("monthly", "", noRange)).toBeNull();
    expect(periodParams("quarterly", "", noRange)).toBeNull();
  });

  it("sends a month range for the presets", () => {
    expect(periodParams("monthly", "2026-8", noRange))
      .toEqual({ from_ym: "2026-08", to_ym: "2026-08" });
    expect(periodParams("quarterly", "2026-Q4", noRange))
      .toEqual({ from_ym: "2027-01", to_ym: "2027-03" });
  });
});

describe("periodMonthBounds / monthInBounds", () => {
  const noRange = { from: "", to: "" };

  it("returns the month range for a preset", () => {
    expect(periodMonthBounds("monthly", "2026-8", noRange)).toEqual(["2026-08", "2026-08"]);
    expect(periodMonthBounds("quarterly", "2026-Q4", noRange)).toEqual(["2027-01", "2027-03"]);
  });

  it("widens a custom day range to the months it touches", () => {
    expect(periodMonthBounds("custom", "", { from: "2026-04-15", to: "2026-06-02" }))
      .toEqual(["2026-04", "2026-06"]);
  });

  it("is null when there is no window to apply", () => {
    // All-time and a half-typed range both mean "don't filter".
    expect(periodMonthBounds("all", "", noRange)).toBeNull();
    expect(periodMonthBounds("custom", "", { from: "2026-04-15", to: "" })).toBeNull();
    expect(periodMonthBounds("monthly", "", noRange)).toBeNull();
  });

  it("keeps everything when there are no bounds", () => {
    expect(monthInBounds(2026, 8, null)).toBe(true);
  });

  it("zero-pads before comparing", () => {
    // The trap: "2026-8" > "2026-12" as a plain string. Months 1–9 would fall
    // outside every bound that crosses October without the pad.
    const b: [string, string] = ["2026-01", "2026-12"];
    expect(monthInBounds(2026, 8, b)).toBe(true);
    expect(monthInBounds(2026, 9, b)).toBe(true);
    expect(monthInBounds(2026, 12, b)).toBe(true);
  });

  it("is inclusive at both ends and excludes outside", () => {
    const b: [string, string] = ["2026-04", "2026-06"];
    expect(monthInBounds(2026, 4, b)).toBe(true);
    expect(monthInBounds(2026, 6, b)).toBe(true);
    expect(monthInBounds(2026, 3, b)).toBe(false);
    expect(monthInBounds(2026, 7, b)).toBe(false);
  });

  it("compares across a year boundary", () => {
    const b: [string, string] = ["2026-11", "2027-02"];
    expect(monthInBounds(2026, 12, b)).toBe(true);
    expect(monthInBounds(2027, 1, b)).toBe(true);
    expect(monthInBounds(2026, 10, b)).toBe(false);
    expect(monthInBounds(2027, 3, b)).toBe(false);
  });
});

describe("buildPeriodOptions", () => {
  // Mar + Apr 2026 straddle the FY boundary: they belong to different FYs and
  // different quarters despite being consecutive months.
  const months: Period[] = [
    { year: 2026, month: 3 },
    { year: 2026, month: 4 },
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
  ];

  it("lists months newest first", () => {
    const { monthly } = buildPeriodOptions(months);
    expect(monthly.map((o) => o.value)).toEqual(["2026-8", "2026-7", "2026-4", "2026-3"]);
    expect(monthly[0].label).toBe("August 2026");
  });

  it("derives quarters and FYs from the months present, without duplicates", () => {
    const { quarterly, yearly } = buildPeriodOptions(months);
    // Jul + Aug collapse into one Q2; Mar sits in FY25-26 Q4; Apr in FY26-27 Q1.
    expect(quarterly.map((o) => o.value)).toEqual(["2026-Q2", "2026-Q1", "2025-Q4"]);
    expect(yearly.map((o) => o.value)).toEqual(["2026", "2025"]);
    expect(yearly.map((o) => o.label)).toEqual(["FY26-27", "FY25-26"]);
  });

  it("survives an empty month list", () => {
    expect(buildPeriodOptions([])).toEqual({ monthly: [], quarterly: [], yearly: [] });
  });

  it("dedupes months arriving from two sources", () => {
    // The Overview unions visit-plan months with log-book months and the two
    // overlap heavily; without dedupe the picker lists August twice.
    const { monthly } = buildPeriodOptions([
      { year: 2026, month: 8 }, { year: 2026, month: 8 }, { year: 2026, month: 7 },
    ]);
    expect(monthly.map((o) => o.value)).toEqual(["2026-8", "2026-7"]);
  });

  it("round-trips a month token through its label", () => {
    expect(tokenLabel(monthToken({ year: 2026, month: 1 }))).toBe("January 2026");
  });
});
