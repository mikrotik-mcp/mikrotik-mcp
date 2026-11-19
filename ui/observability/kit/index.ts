/**
 * Signal UI kit: the one set of form controls and overlays for the whole panel.
 * Boards: "Signal UI kit" row of the Signal Redesign canvas (Kit-*).
 *
 * Pages import from here, never raw <select>, <datalist>, or checkbox, range,
 * number or date inputs (tests/observability-ui.spec.ts checks this).
 */
import "./kit.css";
import "./data.css";

export { Select } from "./select";
export type { SelectProps } from "./select";
export { Combobox, MultiSelect } from "./combobox";
export { RouterPicker, routerOption } from "./router-picker";
export {
  Field,
  TextInput,
  SearchInput,
  NumberInput,
  SecretInput,
  TextArea,
  CopyButton,
} from "./field";
export type { TextInputProps, NumberInputProps } from "./field";
export { Checkbox, Switch, RadioCards, Segmented, Slider } from "./choices";
export type { RadioCardOption, SegmentOption } from "./choices";
export { DateTimePicker, DateRangePicker, DEFAULT_PRESETS } from "./datetime";
export type { DateRange, RangePreset } from "./datetime";
export { Menu, Tooltip, TitleTooltips } from "./overlays";
export type { MenuItem } from "./overlays";
export { Led, Kbd } from "./listbox";
export type { KitOption, Tone } from "./listbox";
export { useField } from "./field-context";
export { isLetterKey } from "./keys";
export { smoothPath } from "./curve";
export {
  ChartTipLayer,
  LineHover,
  TipCardView,
  TipTarget,
  hideTip,
  showTip,
  tipProps,
} from "./chart-tip";
export type { TipAnchor, TipCard, TipRow, LineHoverProps } from "./chart-tip";
export { RowMenu, RowMore, SelectionBar } from "./table";
export type { CellKind, CellMenu, CopyItem, RowAction, RowMenuProps } from "./table";
export { DetailBlock, DetailList, DurationBar, RowDrawer } from "./drawer";
export type { DrawerTab, RowDrawerProps } from "./drawer";
export {
  DUR,
  EASE,
  STAGGER,
  STAGGER_MAX,
  arrive,
  enter,
  reducedMotion,
  swapIn,
  tick,
} from "./motion";
