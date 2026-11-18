/** Field passes its ids to the control inside it, so the label and help are announced. */
import { createContext, useContext } from "react";

export interface FieldState {
  id?: string;
  describedBy?: string;
  invalid?: boolean;
}

export const FieldContext = createContext<FieldState>({});

export function useField(): FieldState {
  return useContext(FieldContext);
}
