import * as RadixSelect from "@radix-ui/react-select";
import React from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional heading this option sits under. Consecutive options sharing one
   *  group become a titled block with a heading that stays put while the list
   *  scrolls. Used by the period picker once it covers more than one financial
   *  year; every other caller passes a flat list and renders exactly as before. */
  group?: string;
}

/** Consecutive options sharing a group, in the order the caller gave them.
 *
 *  Runs, not a bucket-by-group pass: the caller owns the ordering — the period
 *  picker is strictly newest-first — and regrouping here would silently
 *  reorder it. An ungrouped option therefore starts its own untitled run
 *  rather than being folded into the heading above it.
 */
function groupRuns(options: SelectOption[]) {
  const runs: { group?: string; items: SelectOption[] }[] = [];
  for (const opt of options) {
    const last = runs[runs.length - 1];
    if (last && last.group === opt.group) last.items.push(opt);
    else runs.push({ group: opt.group, items: [opt] });
  }
  return runs;
}

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export default function Select({
  value, onChange, options, placeholder = "Select…", disabled, className,
}: SelectProps) {
  return (
    <RadixSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RadixSelect.Trigger
        className={cn(
          "flex items-center justify-between gap-2 text-xs border border-gray-200 rounded-xl px-3 py-2 bg-white text-gray-700 font-medium min-w-[130px]",
          "focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-orange-400 transition",
          "data-[placeholder]:text-gray-500",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "hover:border-orange-300 cursor-pointer",
          className
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown size={13} className="text-gray-500" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          className="z-50 overflow-hidden rounded-xl border border-orange-100 bg-white shadow-lg"
        >
          <RadixSelect.Viewport className="max-h-64 p-1">
            {groupRuns(options).map((run, i) => {
              // No heading means no <Group>: an empty group carries an
              // aria-labelledby pointing at a label that was never rendered.
              const Wrap = run.group ? RadixSelect.Group : React.Fragment;
              return (
              <Wrap key={run.group ?? `run-${i}`}>
                {run.group && (
                  // -top-1 cancels the viewport's p-1 so the heading pins flush
                  // to the top edge and covers that strip; without it rows scroll
                  // through the padding and show above the heading.
                  <RadixSelect.Label className="sticky -top-1 z-10 bg-white px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                    {run.group}
                  </RadixSelect.Label>
                )}
                {run.items.map((opt) => (
                  <RadixSelect.Item
                    key={opt.value}
                    value={opt.value}
                    className={cn(
                      "relative flex items-center gap-2 text-xs font-medium text-gray-600 rounded-lg px-3 py-2 pl-7 cursor-pointer select-none outline-none",
                      "data-[highlighted]:bg-orange-50 data-[highlighted]:text-orange-600",
                      "data-[state=checked]:text-orange-600 data-[state=checked]:font-semibold"
                    )}
                  >
                    <RadixSelect.ItemIndicator className="absolute left-2 inline-flex items-center">
                      <Check size={13} />
                    </RadixSelect.ItemIndicator>
                    <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  </RadixSelect.Item>
                ))}
              </Wrap>
              );
            })}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
