import React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import { cn } from '../../lib/utils';
import ResponsiveSheet from './responsive-sheet';
import useWindow from '../../hooks/UseWindow';

/**
 * Dropdown menus — a Radix popover on desktop, a bottom sheet on a phone.
 *
 * The switch happens here rather than at the twelve call sites, so a menu is
 * written once and is correct on both. On mobile Radix is not mounted at all:
 * its portal, positioning and focus management all assume an anchored popover,
 * and running them underneath a sheet fights the sheet's own scroll lock.
 *
 * What the call sites use, and therefore what the mobile branch honours:
 * Item, Separator, `asChild` triggers, controlled `open`/`onOpenChange`,
 * `onSelect` with `preventDefault()` to keep the menu open, `disabled`, and
 * per-item className (kept, so destructive red items stay red). Desktop-only
 * props — `align`, `side`, `sideOffset`, the content className and any inline
 * positioning style — are dropped on mobile, where a sheet positions itself.
 *
 * Checkbox/radio/sub-menu/label parts are untouched Radix; nothing uses them.
 */

/**
 * Strips the layout classes a call site wrote for a narrow anchored dropdown.
 *
 * They pair `w-full` with `mx-2`, which inside a full-width sheet overflows to
 * the right by exactly the margin — the icon ends up flush against the edge
 * while the label keeps its inset. Width, margin and padding are the sheet's
 * business; colour, weight and layout direction stay the call site's.
 */
const stripBoxClasses = (className) =>
  (className || "")
    .split(/\s+/)
    .filter(
      (c) =>
        c &&
        !/^w-/.test(c) &&
        !/^m[xytrbl]?-/.test(c) &&
        !/^p[xytrbl]?-/.test(c) &&
        !/^rounded/.test(c) &&
        !/^hover:rounded/.test(c)
    )
    .join(" ");

const MenuContext = React.createContext(null);
/** Lets an Item close the sheet through its animated exit rather than snapping. */
const SheetCloseContext = React.createContext(null);

const useIsMobile = () => {
  const { windowSize } = useWindow();
  // Same expression as the two responsive primitives: the hook's own isMobile
  // is false on the first render because width starts undefined.
  return (windowSize.width ?? window.innerWidth) < 768;
};

const DropdownMenu = ({ open: controlledOpen, onOpenChange, children, ...props }) => {
  const isMobile = useIsMobile();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = React.useCallback(
    (next) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange]
  );

  const value = React.useMemo(() => ({ isMobile, open, setOpen }), [isMobile, open, setOpen]);

  if (!isMobile) {
    return (
      <MenuContext.Provider value={value}>
        <DropdownMenuPrimitive.Root open={controlledOpen} onOpenChange={onOpenChange} {...props}>
          {children}
        </DropdownMenuPrimitive.Root>
      </MenuContext.Provider>
    );
  }

  // No Radix root on mobile — the trigger and content coordinate through context.
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>;
};

const DropdownMenuTrigger = React.forwardRef(({ asChild, children, onClick, ...props }, ref) => {
  const menu = React.useContext(MenuContext);

  if (!menu?.isMobile) {
    return (
      <DropdownMenuPrimitive.Trigger ref={ref} asChild={asChild} onClick={onClick} {...props}>
        {children}
      </DropdownMenuPrimitive.Trigger>
    );
  }

  const openSheet = (event) => {
    // Menus live inside cards that navigate on click; opening one must not
    // also follow the card.
    event.preventDefault();
    event.stopPropagation();
    menu.setOpen(true);
  };

  // `asChild` means "use my child as the trigger" — clone it rather than
  // wrapping, or a button ends up inside a button.
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, {
      onClick: (event) => {
        children.props.onClick?.(event);
        onClick?.(event);
        openSheet(event);
      },
    });
  }

  return (
    <button
      type="button"
      ref={ref}
      onClick={(event) => {
        onClick?.(event);
        openSheet(event);
      }}
      {...props}
    >
      {children}
    </button>
  );
});
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const DropdownMenuSubTrigger = React.forwardRef(
  ({ className, inset, children, ...props }, ref) => (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      className={cn(
        'flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none focus:bg-accent data-[state=open]:bg-accent',
        inset && 'pl-8',
        className
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto h-4 w-4" />
    </DropdownMenuPrimitive.SubTrigger>
  )
);
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

const DropdownMenuSubContent = React.forwardRef(
  ({ className, ...props }, ref) => (
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      className={cn(
        'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out',
        className
      )}
      {...props}
    />
  )
);
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';

const DropdownMenuContent = React.forwardRef(
  (
    {
      className,
      sideOffset = 4,
      // Heading for the mobile sheet. A menu with no title still gets a
      // dismissable header, but naming it is much clearer.
      sheetTitle = 'Options',
      align,
      side,
      style,
      children,
      ...props
    },
    ref
  ) => {
    const menu = React.useContext(MenuContext);

    if (!menu?.isMobile) {
      return (
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            ref={ref}
            sideOffset={sideOffset}
            align={align}
            side={side}
            style={style}
            className={cn(
              'z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
              className
            )}
            {...props}
          >
            {children}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      );
    }

    if (!menu.open) return null;

    return (
      <ResponsiveSheet title={sheetTitle} onClose={() => menu.setOpen(false)}>
        {(requestClose) => (
          <SheetCloseContext.Provider value={requestClose}>
            <div className="py-1">{children}</div>
          </SheetCloseContext.Provider>
        )}
      </ResponsiveSheet>
    );
  }
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

const DropdownMenuItem = React.forwardRef(
  ({ className, inset, onSelect, onClick, disabled, children, ...props }, ref) => {
    const menu = React.useContext(MenuContext);
    const closeSheet = React.useContext(SheetCloseContext);

    if (!menu?.isMobile) {
      return (
        <DropdownMenuPrimitive.Item
          ref={ref}
          onSelect={onSelect}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            'relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground',
            inset && 'pl-8',
            className
          )}
          {...props}
        >
          {children}
        </DropdownMenuPrimitive.Item>
      );
    }

    return (
      <button
        type="button"
        ref={ref}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);

          /*
           * Radix hands `onSelect` an event whose preventDefault() keeps the
           * menu open — PostHeader relies on that to swap one menu for
           * another. Emulate just that contract.
           */
          let keepOpen = false;
          onSelect?.({
            ...event,
            preventDefault: () => {
              keepOpen = true;
            },
          });

          if (!keepOpen) closeSheet?.();
        }}
        /*
         * The call site's className survives for what it's actually saying —
         * red destructive items, mainly — but its box model is dropped, so a
         * row written for a 250px popover doesn't overflow a full-width sheet.
         */
        className={cn(
          'w-full flex items-center justify-between gap-3 px-5 py-3.5 text-left text-[15px] font-medium text-white outline-none transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer',
          stripBoxClasses(className)
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuCheckboxItem = React.forwardRef(
  ({ className, children, checked, ...props }, ref) => (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none',
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
);
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

const DropdownMenuRadioItem = React.forwardRef(
  ({ className, children, ...props }, ref) => (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none',
        className
      )}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="h-2 w-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
);
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

const DropdownMenuLabel = React.forwardRef(
  ({ className, inset, ...props }, ref) => {
    const menu = React.useContext(MenuContext);
    if (menu?.isMobile) {
      return (
        <p
          ref={ref}
          className={cn('px-4 pb-1 pt-3 text-[13px] font-medium text-neutral-500', className)}
          {...props}
        />
      );
    }
    return (
      <DropdownMenuPrimitive.Label
        ref={ref}
        className={cn('px-2 py-1.5 text-sm font-semibold', inset && 'pl-8', className)}
        {...props}
      />
    );
  }
);
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = React.forwardRef(
  ({ className, ...props }, ref) => {
    const menu = React.useContext(MenuContext);
    if (menu?.isMobile) {
      // A plain rule: Radix's Separator without a Radix root would warn, and
      // the desktop margins are wrong at sheet width anyway.
      return <div ref={ref} className="my-1 h-px bg-neutral-800" />;
    }
    return (
      <DropdownMenuPrimitive.Separator
        ref={ref}
        className={cn('-mx-1 my-1 h-px bg-neutral-800', className)}
        {...props}
      />
    );
  }
);
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuShortcut = ({ className, ...props }) => (
  <span
    className={cn('ml-auto text-xs tracking-widest opacity-60', className)}
    {...props}
  />
);
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
