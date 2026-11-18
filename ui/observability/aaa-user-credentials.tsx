import { KeyRound, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CopyButton } from "./atoms";
import { MonitorButton, MonitorNote, StatusBadge } from "./monitoring-ui";

/** Uniform 8-character passwords, conditioned on including all four character classes. */
export function generateUserPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*+-?";
  const limit = 256 - (256 % alphabet.length);
  const random = new Uint8Array(16);
  for (;;) {
    let password = "";
    while (password.length < 8) {
      crypto.getRandomValues(random);
      for (const value of random) {
        if (value < limit) password += alphabet[value % alphabet.length];
        if (password.length === 8) break;
      }
    }
    if (
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password)
    )
      return password;
  }
}

export interface CreatedUserReceipt {
  device: string;
  name: string;
  password: string;
  details: [string, string][];
  warning?: string;
}

/** Only the submitted credentials are shown; no existing router secrets are fetched. */
export function UserCreatedDialog({
  user,
  onClose,
  onCloseAutoFocus,
}: {
  user: CreatedUserReceipt;
  onClose: () => void;
  onCloseAutoFocus: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="monitor-dialog max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-[540px] motion-reduce:animate-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus();
        }}
      >
        <DialogHeader className="monitor-dialog-head flex-col gap-3 text-left">
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-sig-soft text-success">
              {user.warning ? (
                <TriangleAlert className="size-5 text-warning" />
              ) : (
                <ShieldCheck className="size-5" />
              )}
            </span>
            <div className="min-w-0">
              <p className="monitor-eyebrow">User Manager · account receipt</p>
              <DialogTitle>User created</DialogTitle>
            </div>
          </div>
          <DialogDescription>
            Save the credentials below before closing this window.
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="good" dot={false}>
              {user.device}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">
              {user.warning ? "Profile needs attention" : "Creation confirmed"}
            </span>
          </div>
        </DialogHeader>
        <div className="monitor-dialog-body grid gap-4">
          {user.warning && (
            <MonitorNote tone="warn">
              <b>Check the profile.</b> {user.warning}
            </MonitorNote>
          )}
          <div className="glass overflow-hidden">
            <div className="border-b border-dashed border-line px-4 py-3">
              <p className="mb-1 text-xs text-muted-foreground">Username</p>
              <p className="select-text break-all font-mono text-lg font-semibold" dir="ltr">
                {user.name}
              </p>
            </div>
            <div className="grid gap-3 p-4">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRound className="size-3.5" />
                Password
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <code
                  aria-label="Created user password"
                  dir="ltr"
                  className="select-text break-all font-mono text-2xl font-semibold tracking-wider text-success"
                >
                  {user.password || "Not provided"}
                </code>
                {user.password && (
                  <CopyButton
                    text={user.password}
                    label="Copy password"
                    title="Copy password"
                    className="shrink-0"
                  />
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This dashboard clears the password when you close this window. You cannot reveal it
                again here.
              </p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-5 gap-y-4">
            {user.details.map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="mb-1 text-xs text-muted-foreground">{label}</dt>
                <dd className="break-words text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <DialogFooter className="monitor-dialog-foot">
          <MonitorButton variant="primary" onClick={onClose}>
            Done
          </MonitorButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
