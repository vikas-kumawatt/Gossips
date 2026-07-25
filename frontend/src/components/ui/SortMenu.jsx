import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import ResponsiveSheet from "./responsive-sheet";
import useWindow from "../../hooks/UseWindow";

export const ACTIVITY_SORT_OPTIONS = [
  {
    value: "default",
    label: "Default",
    hint: "People you follow first",
  },
  {
    value: "recent",
    label: "Most recent",
    hint: "Newest activity first",
  },
];

/** The round selector Instagram uses for single-choice lists. */
const Radio = ({ checked }) => (
  <span
    className={`shrink-0 w-[20px] h-[20px] rounded-full border-2 flex items-center justify-center transition-colors ${
      checked ? "border-white" : "border-neutral-600"
    }`}
  >
    {checked && <span className="w-[10px] h-[10px] rounded-full bg-white" />}
  </span>
);

/**
 * SortMenu — a dropdown on desktop, a bottom sheet on mobile.
 *
 * Both render the same option rows, so the selected state reads identically
 * either way; only the container changes with the viewport.
 */
const SortMenu = ({
  value,
  onChange,
  options = ACTIVITY_SORT_OPTIONS,
  label = "Sort",
  title = "Sort by",
}) => {
  const { windowSize } = useWindow();
  const isMobile = (windowSize.width ?? window.innerWidth) < 768;
  const [sheetOpen, setSheetOpen] = useState(false);

  const trigger = (
    <button
      type="button"
      className="text-[15px] font-medium text-white hover:text-neutral-300 transition-colors cursor-pointer"
    >
      {label}
    </button>
  );

  const rows = (onPick) =>
    options.map((option) => (
      <button
        key={option.value}
        type="button"
        onClick={() => onPick(option.value)}
        className="w-full flex items-center justify-between gap-3 text-left px-4 py-3.5 hover:bg-neutral-800 transition-colors cursor-pointer"
      >
        <span className="min-w-0">
          <span className="block text-[15px] font-medium text-white">{option.label}</span>
          {option.hint && (
            <span className="block text-[13px] text-neutral-500 mt-0.5">{option.hint}</span>
          )}
        </span>
        <Radio checked={value === option.value} />
      </button>
    ));

  if (isMobile) {
    return (
      <>
        <span onClick={() => setSheetOpen(true)}>{trigger}</span>
        {sheetOpen && (
          <ResponsiveSheet title={title} onClose={() => setSheetOpen(false)}>
            {(close) => (
              <div className="py-1">
                {rows((next) => {
                  onChange(next);
                  close();
                })}
              </div>
            )}
          </ResponsiveSheet>
        )}
      </>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="shadow-xl bg-[#181818] z-[2100] rounded-2xl w-[260px] mt-1 p-0 border border-neutral-700 overflow-hidden"
      >
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onChange(option.value)}
            className="flex items-center justify-between gap-3 px-4 py-3.5 cursor-pointer text-white hover:bg-neutral-800 outline-none"
          >
            <span className="min-w-0">
              <span className="block text-[15px] font-medium">{option.label}</span>
              {option.hint && (
                <span className="block text-[13px] text-neutral-500 mt-0.5">{option.hint}</span>
              )}
            </span>
            <Radio checked={value === option.value} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default SortMenu;
