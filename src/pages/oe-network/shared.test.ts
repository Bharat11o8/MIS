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
  carryPeriod,
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
    // The full financial year, matching fyLabel and the backend's own quarter
    // labels. "Q1 FY27" would leave a reader guessing whether FY27 starts or
    // ends in 2027 — and the yearly picker beside it says "FY26-27".
    expect(quarterLabel(quarterToken(2026, 1))).toBe("Q1 FY26-27");
    expect(quarterLabel(quarterToken(2026, 4))).toBe("Q4 FY26-27");
    expect(quarterLabel(quarterToken(2027, 1))).toBe("Q1 FY27-28");
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

  it("leaves a single financial year unheaded", () => {
    // One heading over every row is noise, and it appears the moment a tab has
    // only ever been given one year's sheet — which is most of them.
    const { monthly } = buildPeriodOptions(months.filter((p) => p.month >= 4));
    expect(monthly.every((o) => o.group === undefined)).toBe(true);
  });

  it("heads months by financial year once a second one is registered", () => {
    // Two full years, the case that made a 24-row dropdown.
    const two: Period[] = [];
    for (let i = 0; i < 24; i++) {
      const abs = 2026 * 12 + 3 + i;            // April 2026 onwards
      two.push({ year: Math.floor(abs / 12), month: (abs % 12) + 1 });
    }
    const { monthly } = buildPeriodOptions(two);
    expect(monthly).toHaveLength(24);
    expect(monthly[0].label).toBe("March 2028");
    expect(monthly[0].group).toBe("FY27-28");
    expect(monthly[23].label).toBe("April 2026");
    expect(monthly[23].group).toBe("FY26-27");

    // The headings must come out as two unbroken runs, because the Select
    // draws a heading per RUN. Newest-first month order already puts each FY
    // together; if it ever stopped doing so, the picker would grow a second
    // "FY26-27" heading halfway down rather than reorder anything.
    const runs = monthly.map((o) => o.group)
      .filter((g, i, a) => i === 0 || g !== a[i - 1]);
    expect(runs).toEqual(["FY27-28", "FY26-27"]);

    // Jan–Mar 2027 are calendar 2027 but financial FY26-27 — the reason the
    // labels keep their calendar year instead of shortening to "January".
    const jan27 = monthly.find((o) => o.value === "2027-1");
    expect(jan27).toMatchObject({ label: "January 2027", group: "FY26-27" });
  });

  it("keeps quarterly and yearly unheaded — they never outgrow one screen", () => {
    const { quarterly, yearly } = buildPeriodOptions(months);
    expect([...quarterly, ...yearly].every((o) => !("group" in o))).toBe(true);
  });
});


describe("carryPeriod", () => {
  // Two full financial years, the case a single 24-row month list made painful.
  const twoYears: Period[] = [];
  for (let i = 0; i < 24; i++) {
    const abs = 2026 * 12 + 3 + i;               // April 2026 onwards
    twoYears.push({ year: Math.floor(abs / 12), month: (abs % 12) + 1 });
  }
  const opts = buildPeriodOptions(twoYears);
  const carry = (from: "monthly" | "quarterly" | "yearly" | "custom" | "all",
                 token: string, to: "monthly" | "quarterly" | "yearly") =>
    carryPeriod(from, token, to, opts[to])?.value;

  it("narrows a year to the newest quarter and month inside it", () => {
    // The point of the whole thing: FY26-27 → Q3 → December, without ever
    // scrolling past FY27-28.
    expect(carry("yearly", "2026", "quarterly")).toBe("2026-Q4");
    expect(carry("yearly", "2026", "monthly")).toBe("2027-3");
    expect(carry("quarterly", "2026-Q3", "monthly")).toBe("2026-12");
  });

  it("widens a month to the period that contains it", () => {
    expect(carry("monthly", "2026-8", "quarterly")).toBe("2026-Q2");
    expect(carry("monthly", "2026-8", "yearly")).toBe("2026");
    // Jan 2027 is FY26-27 Q4, not FY27-28 Q1 — the boundary that makes this
    // worth a test rather than a slice of the token.
    expect(carry("monthly", "2027-1", "quarterly")).toBe("2026-Q4");
    expect(carry("monthly", "2027-1", "yearly")).toBe("2026");
    expect(carry("monthly", "2027-4", "yearly")).toBe("2027");
  });

  it("round-trips without drifting between years", () => {
    // Widen then narrow must not walk you into the other financial year.
    const q = carry("monthly", "2026-5", "quarterly")!;
    expect(q).toBe("2026-Q1");
    expect(carry("quarterly", q, "monthly")).toBe("2026-6");
    const y = carry("quarterly", q, "yearly")!;
    expect(y).toBe("2026");
    expect(carry("yearly", y, "quarterly")).toBe("2026-Q4");
  });

  it("falls back to the newest period when nothing carries over", () => {
    // custom and all-time hold no token, and neither does a fresh mount.
    expect(carry("custom", "", "monthly")).toBe("2028-3");
    expect(carry("all", "", "quarterly")).toBe("2027-Q4");
    expect(carry("monthly", "", "yearly")).toBe("2027");
    // A token for a period the data no longer covers must not select nothing.
    expect(carry("yearly", "2019", "monthly")).toBe("2028-3");
  });

  it("returns null rather than a token when there is no data", () => {
    expect(carryPeriod("monthly", "2026-8", "monthly", [])).toBeNull();
  });

  it("keeps the exact month when the mode does not change", () => {
    // Switching away and back is a normal thing to do, and it must be a no-op.
    expect(carry("monthly", "2026-11", "monthly")).toBe("2026-11");
    expect(carry("quarterly", "2026-Q3", "quarterly")).toBe("2026-Q3");
  });
});
