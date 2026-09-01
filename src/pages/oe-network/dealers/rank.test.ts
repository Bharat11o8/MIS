import { describe, expect, it } from "vitest";
import { RANK_META, RANK_METRICS, rankMeta, rankValue, rankLabel, oursOf, type PerfDealer, type RankMetric, totalLabel, oursLabels } from "./model";

/**
 * The sign convention on the Dealers tab.
 *
 * This is the exact bug class a test is for: flip either signed metric and
 * nothing crashes, no column goes blank, and every figure still looks entirely
 * plausible — it just means the opposite of what the reader thinks. The module
 * shipped for months with the Targets tab reading `+` as ahead while this tab
 * read `+` as behind.
 *
 * The rule, module-wide: **+ means we are doing well.** Both signed metrics are
 * therefore written ACTUAL minus EXPECTED.
 */

const dealer = (over: Partial<PerfDealer> = {}): PerfDealer => ({
  id: "d1",
  name: "A M MOTORS",
  city: "MALAPPURAM",
  state: "KERALA",
  salesperson: "ASHOKA",
  oem: "MSIL",
  oem_total: 1000,
  ysasc: 500,
  ys_sale: 100,
  penetration: 20,
  addressable_pct: 50,
  contacts: 3,
  has_sales: true,
  target: null,
  achievement: null,
  sold: null,
  last_contact: null,
  ...over,
} as PerfDealer);

describe("vs Average", () => {
  // Benchmark 20%: this dealer's 500 addressable covers predict 100 units.
  it("is positive when the dealer beats the network average", () => {
    const d = dealer({ ysasc: 500, ys_sale: 150 });
    expect(rankValue(d, "gap", 20)).toBe(50);
  });

  it("is negative when the dealer falls short of it", () => {
    const d = dealer({ ysasc: 500, ys_sale: 60 });
    expect(rankValue(d, "gap", 20)).toBe(-40);
  });

  it("is zero for a dealer sitting exactly on the average", () => {
    expect(rankValue(dealer({ ysasc: 500, ys_sale: 100 }), "gap", 20)).toBe(0);
  });

  it("treats a dealer with no addressable base as zero, not as a huge shortfall", () => {
    // Nothing is known about what this dealer COULD have bought, so predicting a
    // gap from it would invent a number and drop the dealer to the bottom of a
    // work list they do not belong on.
    expect(rankValue(dealer({ ysasc: null, ys_sale: 0 }), "gap", 20)).toBe(0);
  });
});

describe("vs Target", () => {
  it("is positive when the dealer is past target", () => {
    expect(rankValue(dealer({ target: 100, sold: 130 }), "tgt_gap", 0)).toBe(30);
  });

  it("is negative when the dealer is short of it", () => {
    expect(rankValue(dealer({ target: 100, sold: 70 }), "tgt_gap", 0)).toBe(-30);
  });

  it("falls back to ys_sale when the quarter has no summed figure yet", () => {
    expect(rankValue(dealer({ target: 100, sold: null, ys_sale: 40 }), "tgt_gap", 0)).toBe(-60);
  });
});

describe("the convention holds across both metrics", () => {
  it("agrees on which direction is good", () => {
    // The one property that matters: a dealer doing well is positive on
    // whichever signed metric their OEM's file can answer. A funnel OEM and a
    // target-only OEM must not disagree about what a plus sign means.
    const ahead = dealer({ ysasc: 500, ys_sale: 150, target: 100, sold: 150 });
    expect(rankValue(ahead, "gap", 20)).toBeGreaterThan(0);
    expect(rankValue(ahead, "tgt_gap", 20)).toBeGreaterThan(0);

    const behind = dealer({ ysasc: 500, ys_sale: 50, target: 100, sold: 50 });
    expect(rankValue(behind, "gap", 20)).toBeLessThan(0);
    expect(rankValue(behind, "tgt_gap", 20)).toBeLessThan(0);
  });

  it("names the signed metrics neutrally, so the sign is free to carry meaning", () => {
    // "Opportunity" and "Behind target" both state a direction, which pins + to
    // meaning "behind" and puts the label at war with the number.
    expect(RANK_META.gap.signed).toBe(true);
    expect(RANK_META.gap.label).toMatch(/^vs /);
  });

  it("ranks our units on the figure the scope actually displays", () => {
    // A target-only OEM shows `sold` (the whole quarter the target covers) in
    // its Amato SC Sale column; a funnel OEM shows `ys_sale` (the filtered
    // months). They are equal on a whole-quarter period, so a mix-up is
    // invisible until someone filters to a single month — at which point the
    // "top 20" is ordered by a number that is not in the column.
    const d = dealer({ ys_sale: 40, sold: 120, target: 100 });
    expect(oursOf(d, true)).toBe(40);
    expect(oursOf(d, false)).toBe(120);
    expect(rankValue(d, "ys_sale", 20, true)).toBe(40);
    expect(rankValue(d, "ys_sale", 20, false)).toBe(120);
  });

  it("falls back to ys_sale when a target-only OEM has no quarter to sum", () => {
    // `sold` is null for a dealer whose months touch no quarter at all. Reading
    // that as 0 would drop a real dealer to the bottom of the list.
    const d = dealer({ ys_sale: 40, sold: null, target: 100 });
    expect(oursOf(d, false)).toBe(40);
  });

  it("makes tgt_gap state its own sign, because its name no longer does", () => {
    // The OE team asked for "Remaining Target" over the neutral "vs Target".
    // The sign was NOT flipped to match — + still means ahead, module-wide — so
    // the name now points the opposite way to the number and the description is
    // the only thing left telling the reader which. If someone rewrites `what`
    // and drops the sign, this column becomes unreadable, so pin it here.
    expect(RANK_META.tgt_gap.signed).toBe(true);
    expect(RANK_META.tgt_gap.what).toMatch(/\+ is AHEAD/);
    expect(RANK_META.tgt_gap.what).toMatch(/− is still to go/);
  });

  it("marks only the signed metrics as signed", () => {
    // The table picks its default end from this flag, so a volume ranking
    // wrongly marked signed would open on the smallest dealers.
    for (const m of ["ys_sale", "penetration", "oem_total", "ysasc"] as RankMetric[]) {
      expect(RANK_META[m].signed).toBeFalsy();
    }
  });

  it("offers a signed metric first in both scopes, so the tab opens on the work list", () => {
    for (const funnel of [true, false]) {
      expect(RANK_META[RANK_METRICS(funnel)[0]].signed).toBe(true);
    }
  });
});

describe("the total column carries the OEM's own name", () => {
  it("names the OEM in view", () => {
    // "Total MSIL SC Sales" stopped being a safe constant the day TATA started
    // publishing a total of its own. Printed over TATA rows it names the wrong
    // OEM, which reads as the filter having failed rather than as a caption.
    expect(totalLabel(["MSIL"])).toBe("Total MSIL SC Sales");
    expect(totalLabel(["TATA"])).toBe("Total TATA SC Sales");
  });

  it("names no OEM when several are in view", () => {
    // Picking one of them would be a claim about rows belonging to the other.
    expect(totalLabel(["MSIL", "TATA"])).toBe("Total OEM SC Sales");
    expect(totalLabel([])).toBe("Total OEM SC Sales");
  });

  it("uses that name for the oem_total ranking too, so the picker and the column agree", () => {
    expect(rankLabel("oem_total", true, ["TATA"])).toBe("Total TATA SC Sales");
  });
});

describe("our units are named the way the OEM's own file names them", () => {
  it("says YS on MSIL and Amato on TATA", () => {
    // MSIL's file says YSC / YSASC / TOTAL YS. TATA's says AMATO
    // ("JULY'26 ACH SC AMATO"). A rep reads this tab with the sheet open.
    expect(oursLabels(["MSIL"], ["SC"])).toEqual({
      sale: "YS SC Sale", avail: "Available YS Part Number", share: "YS Share",
    });
    expect(oursLabels(["TATA"], ["SC"])).toEqual({
      sale: "Amato SC Sale", avail: "Available Amato Part Number", share: "Amato Share",
    });
  });

  it("goes neutral when several OEMs are in view", () => {
    // Naming one of them would be a claim about the other's rows.
    expect(oursLabels(["MSIL", "TATA"], ["SC"]).sale).toBe("Our SC Sale");
    expect(oursLabels([]).share).toBe("Our Share");
  });

  it("names TATA's units Amato whether or not the scope has a funnel", () => {
    // THE REGRESSION. The name used to be inferred from `funnel` — no funnel
    // meant TATA meant "Amato". That died the day TATA published a seat-cover
    // total: filtered to seat covers TATA now HAS a funnel, and the old rule
    // captioned its column with MSIL's word for a different company's units.
    expect(rankLabel("ys_sale", false, ["TATA"], ["SC"])).toBe("Amato SC Sale");
    expect(rankLabel("ys_sale", true, ["TATA"], ["SC"])).toBe("Amato SC Sale");
    expect(rankLabel("penetration", true, ["TATA"])).toBe("Amato Share");
    expect(rankLabel("ysasc", true, ["TATA"])).toBe("Available Amato Part Number");
    // MSIL keeps its own vocabulary in both scopes.
    expect(rankLabel("ys_sale", true, ["MSIL"], ["SC"])).toBe("YS SC Sale");
    expect(rankLabel("penetration", true, ["MSIL"])).toBe("YS Share");
  });
});

describe("full coverage removes the duplicate addressable figure", () => {
  it("drops the addressable ranking when it would duplicate the total", () => {
    // We hold a part number for TATA's whole range, so addressable IS the
    // dealer's total. Offering both orders the list identically twice and the
    // picker looks broken.
    expect(RANK_METRICS(true, false)).toContain("ysasc");
    expect(RANK_METRICS(true, true)).not.toContain("ysasc");
    // The rest of the funnel rankings are untouched.
    expect(RANK_METRICS(true, true)).toEqual(["gap", "ys_sale", "penetration", "oem_total"]);
    // A target-only scope never had it.
    expect(RANK_METRICS(false)).toEqual(["tgt_gap", "ys_sale"]);
  });
});

describe("the ranking's explanation speaks the OEM's vocabulary", () => {
  it("fills the tokens rather than naming MSIL's figures on a TATA tab", () => {
    // The prose sits directly under the numbers. Left hardcoded it described a
    // different company's figures in a sentence that still reads correctly,
    // which is the kind of wrong nobody reports.
    const tata = rankMeta("gap", ["TATA"]);
    expect(tata.what).toContain("Available Amato Part Number");
    expect(tata.what).toContain("Amato Share");
    expect(tata.what).not.toContain("YS Share");

    const msil = rankMeta("penetration", ["MSIL"], ["SC"]);
    expect(msil.what).toContain("YS SC Sale");
    expect(msil.what).toContain("Available YS Part Number");
  });

  it("leaves no unfilled tokens in any metric, for either OEM", () => {
    for (const oems of [["MSIL"], ["TATA"], ["MSIL", "TATA"], []]) {
      for (const m of RANK_METRICS(true)) {
        const meta = rankMeta(m, oems);
        for (const t of [meta.what, meta.top, meta.bottom]) {
          expect(t, `${m} / ${oems.join("+")}`).not.toMatch(/\{(sale|avail|share)\}/);
        }
      }
    }
  });
});

describe("the units label names the products it actually covers", () => {
  it("drops the product word when the figure spans more than one product", () => {
    // TATA unfiltered is seat covers AND mats. "Amato SC Sale" over that number
    // put a seat-cover name on a total containing mats — and the seat-cover-only
    // panel right below it carried the SAME caption over a different figure.
    expect(oursLabels(["TATA"], ["MAT", "SC"]).sale).toBe("Amato Sale");
    expect(oursLabels(["TATA"], ["SC"]).sale).toBe("Amato SC Sale");
    expect(oursLabels(["TATA"], ["MAT"]).sale).toBe("Amato Mats Sale");
  });

  it("leaves MSIL's single-product captions exactly as they were", () => {
    expect(oursLabels(["MSIL"], ["SC"]).sale).toBe("YS SC Sale");
  });

  it("says nothing rather than guessing when the products are unknown", () => {
    expect(oursLabels(["MSIL"]).sale).toBe("YS Sale");
  });
});
