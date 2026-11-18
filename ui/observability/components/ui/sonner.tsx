import type { ComponentProps } from "react";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/theme";

type ToasterProps = ComponentProps<typeof Sonner>;

/**
 * Sonner toaster in the Signal kit's toast style (Kit-Overlays 03): bottom
 * right, newest on top, at most three, with a timer line that pauses on hover.
 * Mounted once at the app root; call `toast(...)` from anywhere.
 */
function Toaster(props: ToasterProps): React.ReactNode {
  const [theme] = useTheme();
  return (
    <Sonner
      theme={theme}
      className="kit-toaster"
      position="bottom-right"
      visibleToasts={3}
      gap={10}
      toastOptions={{
        unstyled: true,
        duration: 4000,
        classNames: {
          toast: "kit-toast",
          icon: "ic",
          content: "tx",
          title: "kit-toast-title",
          description: "kit-toast-desc",
          actionButton: "kit-btn",
          cancelButton: "kit-btn",
          closeButton: "kit-ib",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
export { toast } from "sonner";
