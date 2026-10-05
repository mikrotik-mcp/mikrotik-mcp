import { Fragment } from "react";
import type { ReactNode } from "react";
import { Copy, MoreHorizontal, Pencil, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { TableCell, TableRow } from "@/components/ui/table";

interface UserActionRowProps {
  name: string;
  busy: boolean;
  disabled: boolean;
  children: ReactNode;
  onDuplicate: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}

/** Both entry points share the same actions; opening a menu never mutates a user. */
export function UserActionRow({
  name,
  busy,
  disabled,
  children,
  onDuplicate,
  onEdit,
  onToggle,
  onRemove,
}: UserActionRowProps) {
  const actions = [
    { label: "Edit", icon: Pencil, onSelect: onEdit },
    { label: "Duplicate", icon: Copy, onSelect: onDuplicate },
    { label: disabled ? "Enable" : "Disable", icon: Power, onSelect: onToggle },
    { label: "Remove", icon: Trash2, onSelect: onRemove, destructive: true },
  ];
  const items = (context: boolean) => {
    const Item = context ? ContextMenuItem : DropdownMenuItem;
    const Label = context ? ContextMenuLabel : DropdownMenuLabel;
    const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
    return (
      <>
        <Label className="max-w-52 truncate text-xs text-muted-foreground">{name}</Label>
        <Separator />
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
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={busy}>
        <TableRow>
          {children}
          <TableCell className="w-12 text-right">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy}
                  aria-label={`Actions for ${name}`}
                  title={`Actions for ${name} · or right-click this row`}
                >
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {items(false)}
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">{items(true)}</ContextMenuContent>
    </ContextMenu>
  );
}
