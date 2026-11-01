"use client";
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

type Props = { label: string; children: ReactNode; align?: "start" | "center" | "end" };

/**
 * An information button for secondary explanation that would otherwise sit as a paragraph under a control. It opens
 * on click or keyboard rather than hover, so it behaves the same on touch screens; Escape or an outside click closes it.
 * While open it counts as a shortcut layer, so single-key shortcuts and Escape-to-go-back leave the page alone.
 */
export default function InfoTip({ label, children, align = "start" }: Props) {
  return <PopoverPrimitive.Root>
    <PopoverPrimitive.Trigger className="info-tip-trigger" aria-label={label} title={label}><Info size={15} aria-hidden="true" /></PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content className="info-tip" side="bottom" align={align} sideOffset={6} collisionPadding={16} data-shortcut-layer>
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}
