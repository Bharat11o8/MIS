import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export default function MultiSelect({
  values, onChange, options, placeholder = "All", disabled, className,
}: MultiSelectProps) {
  const toggle = (value: string) => {
    onChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value]);
  };

  const triggerLabel =
    values.length === 0
      ? placeholder
      : values.length === 1
      ? options.find((o) => o.value === values[0])?.label ?? placeholder
      : `${values.length} selected`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "flex items-center justify-between gap-2 text-xs border border-gray-200 rounded-xl px-3 py-2 bg-white text-gray-700 font-medium min-w-[130px]",
            "focus:outline-none focus:ring-2 focus:ring-orange-300 focus:border-orange-400 transition",
            values.length === 0 && "text-gray-400",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "hover:border-orange-300 cursor-pointer",
            className
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown size={13} className="text-gray-400 shrink-0" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={6}
          className="z-50 min-w-[150px] overflow-hidden rounded-xl border border-orange-100 bg-white shadow-lg p-1"
        >
          <div className="max-h-64 overflow-y-auto">
            {options.map((opt) => {
              const checked = values.includes(opt.value);
              return (
                <DropdownMenu.CheckboxItem
                  key={opt.value}
                  checked={checked}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={() => toggle(opt.value)}
                  className={cn(
                    "flex items-center gap-2 text-xs font-medium text-gray-600 rounded-lg px-2.5 py-2 cursor-pointer select-none outline-none",
                    "data-[highlighted]:bg-orange-50 data-[highlighted]:text-orange-600"
                  )}
                >
                  <span
                    className={cn(
                      "w-3.5 h-3.5 rounded-md border flex items-center justify-center shrink-0 transition-colors",
                      checked ? "bg-orange-500 border-orange-500" : "border-gray-300"
                    )}
                  >
                    {checked && <span className="w-1.5 h-1.5 rounded-sm bg-white" />}
                  </span>
                  {opt.label}
                </DropdownMenu.CheckboxItem>
              );
            })}
          </div>
          {values.length > 0 && (
            <>
              <DropdownMenu.Separator className="h-px bg-orange-50 my-1" />
              <button
                onClick={() => onChange([])}
                className="flex items-center gap-1.5 w-full text-left text-xs font-semibold text-red-500 hover:bg-red-50 rounded-lg px-2.5 py-2 transition-colors"
              >
                <X size={12} /> Clear
              </button>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
