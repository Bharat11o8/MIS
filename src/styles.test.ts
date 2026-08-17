/**
 * Guards against Tailwind classes that compile to NOTHING.
 *
 * This is here because of a real bug: a chart tooltip was styled
 * `bg-gray-900/92`. Tailwind's default opacity scale steps by 5, so `/92` is
 * not a real utility and no rule was ever emitted — the tooltip rendered with a
 * transparent background and its white text disappeared into the white chart.
 * Nothing failed: not the build, not the type-checker, not the linter. The only
 * symptom was an unreadable panel in production.
 *
 * Off-scale values are legal in Tailwind, but only in bracket form
 * (`bg-gray-900/[0.92]`), which this check allows.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [p] : [];
  });
}

/** `bg-gray-900/92` — a colour utility with a bare numeric opacity modifier. */
const OPACITY = /\b(?:bg|text|border|placeholder|from|to|via|ring|divide|fill|stroke|shadow)-[a-z]+(?:-\d{2,3})?\/(\d{1,3})\b/g;

/**
 * Text greys below the WCAG AA floor on a white card.
 *
 * Contrast against #fff: gray-300 is 1.5:1 and gray-400 is 2.5:1, against a
 * 4.5:1 requirement for normal text. The app had 452 of these and the faint
 * captions were a standing complaint. gray-500 (4.8:1) is the floor for
 * anything meant to be read.
 *
 * gray-400 survives only as a genuinely non-textual tier — icons, the "—"
 * no-data marker, and switched-off states that also carry a strikethrough —
 * so it is warned about rather than banned. gray-300 has no such use.
 */
const DEAD_GREY = /\btext-gray-300\b/g;

describe("Tailwind opacity modifiers", () => {
  it("only uses values on the 5-step scale", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // Split on \r?\n, not \n: on a CRLF checkout a trailing \r survives, and
      // JS `.` does not match \r — so `//.*$` fails to strip the comment and
      // this check reports its own documentation as a violation.
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        // Skip comments — this file's own docs mention the broken class.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        for (const m of code.matchAll(OPACITY)) {
          if (Number(m[1]) % 5 !== 0) {
            offenders.push(`${file.replace(SRC, "src")}:${i + 1} → ${m[0]}`);
          }
        }
      });
    }
    expect(offenders, "off-scale opacity compiles to no CSS at all").toEqual([]);
  });
});

describe("text contrast", () => {
  it("never uses text-gray-300, which is 1.5:1 on white", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // Split on \r?\n, not \n: on a CRLF checkout a trailing \r survives, and
      // JS `.` does not match \r — so `//.*$` fails to strip the comment and
      // this check reports its own documentation as a violation.
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
        for (const m of code.matchAll(DEAD_GREY)) {
          offenders.push(`${file.replace(SRC, "src")}:${i + 1} → ${m[0]}`);
        }
      });
    }
    expect(offenders, "use text-gray-500 for readable text, gray-400 for icons").toEqual([]);
  });
});
