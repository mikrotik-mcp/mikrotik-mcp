import { Fragment, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Copy, MoreHorizontal, Pencil, Power, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface RowAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
}

/**
 * A table row with the boards' row menu: the ⋯ button in the last cell and the
 * same menu on right-click. The row reads as selected while its menu is open.
 * Opening a menu never changes anything.
 */
export function ActionRow({
  name,
  busy,
  actions,
  children,
  className,
  style,
}: {
  name: string;
  busy: boolean;
  actions: RowAction[];
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const items = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Label = context ? ContextMenuLabel : DropdownMenuLabel;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    return (
      <>
        <Label className="aaa-menu-label">{name}</Label>
        {actions.map(({ label, icon: Icon, onSelect, destructive }) => (
          <Fragment key={label}>
            {destructive && <Separator />}
            <Item
              disabled={busy}
              variant={destructive ? "destructive" : "default"}
              onSelect={onSelect}
            >
              <Icon aria-hidden="true" />
              {label}
            </Item>
          </Fragment>
        ))}
      </>
    );
  };

  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger asChild disabled={busy}>
        <tr
          className={cn("monitor-row", className)}
          style={style}
          data-selected={menuOpen || contextOpen || undefined}
        >
          {children}
          <td className="aaa-cell-action">
            <DropdownMenu onOpenChange={setMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="aaa-ib"
                  disabled={busy}
                  aria-label={`Actions for ${name}`}
                  title={`Actions for ${name} · or right-click this row`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="aaa-menu">
                {items(false)}
              </DropdownMenuContent>
            </DropdownMenu>
          </td>
        </tr>
      </ContextMenuTrigger>
      <ContextMenuContent className="aaa-menu">{items(true)}</ContextMenuContent>
    </ContextMenu>
  );
}

interface UserActionRowProps {
  name: string;
  busy: boolean;
  disabled: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  onDuplicate: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}

/** Both entry points share the same actions; opening a menu never mutates a user. */
export function UserActionRow({
  disabled,
  onDuplicate,
  onEdit,
  onToggle,
  onRemove,
  ...row
}: UserActionRowProps) {
  return (
    <ActionRow
      {...row}
      actions={[
        { label: "Edit", icon: Pencil, onSelect: onEdit },
        { label: "Duplicate", icon: Copy, onSelect: onDuplicate },
        { label: disabled ? "Enable" : "Disable", icon: Power, onSelect: onToggle },
        { label: "Remove", icon: Trash2, onSelect: onRemove, destructive: true },
      ]}
    />
  );
}
