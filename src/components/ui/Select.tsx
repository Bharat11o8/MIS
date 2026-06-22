import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectOption {
  value: string;
  label: string;
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
          "data-[placeholder]:text-gray-400",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "hover:border-orange-300 cursor-pointer",
          className
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon>
          <ChevronDown size={13} className="text-gray-400" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={6}
          className="z-50 overflow-hidden rounded-xl border border-orange-100 bg-white shadow-lg"
        >
          <RadixSelect.Viewport className="max-h-64 p-1">
            {options.map((opt) => (
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
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
