import { Component } from "react";
import type { ReactNode } from "react";
import { Button } from "./components/ui/button";

/** Keep navigation usable if a page or a third-party example fails to render. */
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <section role="alert" className="rounded-xl border border-destructive/40 bg-card p-6">
          <h2 className="font-semibold">This view could not be displayed</h2>
          <p className="my-3 text-sm text-muted-foreground">
            Your router configuration has not been changed by this display error. You can retry or
            open another page from the menu.
          </p>
          <Button variant="outline" onClick={() => this.setState({ failed: false })}>
            Retry view
          </Button>
        </section>
      );
    return this.props.children;
  }
}
