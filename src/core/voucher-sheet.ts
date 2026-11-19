/**
 * A printable sheet of hotspot vouchers: one HTML file, cards in a grid that
 * fits A4 or Letter, cut lines between them. PURE.
 *
 * Every value is escaped, the file holds no script, and a Content-Security-
 * Policy forbids loading anything from outside: it is safe to open and to send.
 */
import { qrPng } from "./wireguard-portal";

export interface VoucherSheet {
  /** Shown on every card, e.g. the venue or network name. */
  title: string;
  batch: string;
  codes: string[];
  /** e.g. "1 day" */
  validity?: string;
  /** e.g. "5 EUR" */
  price?: string;
  /** Hotspot login address. With it, each card gets a QR code that signs in. */
  loginUrl?: string;
  /** A line of small print, e.g. how to connect. */
  note?: string;
}

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The sign-in address for one code, or undefined when the base is not http(s). */
export function loginLink(loginUrl: string | undefined, code: string): string | undefined {
  if (!loginUrl) return undefined;
  try {
    const url = new URL(loginUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.searchParams.set("username", code);
    url.searchParams.set("password", code);
    return url.href;
  } catch {
    return undefined;
  }
}

export function voucherSheetHtml(sheet: VoucherSheet): string {
  const cards = sheet.codes
    .map((code) => {
      const link = loginLink(sheet.loginUrl, code);
      const qr = link
        ? `<img alt="" src="data:image/png;base64,${qrPng(link, 3).toString("base64")}">`
        : "";
      return [
        '<div class="card">',
        `<div class="text"><div class="title">${escape(sheet.title)}</div>`,
        `<div class="code">${escape(code)}</div>`,
        `<div class="meta">${[sheet.validity, sheet.price]
          .filter(Boolean)
          .map((v) => escape(v!))
          .join(" · ")}</div>`,
        sheet.note ? `<div class="note">${escape(sheet.note)}</div>` : "",
        "</div>",
        qr,
        "</div>",
      ].join("");
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${escape(sheet.title)} — vouchers ${escape(sheet.batch)}</title>
<style>
  @page { margin: 10mm; }
  body { margin: 0; font: 12px/1.35 system-ui, sans-serif; color: #111; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); }
  .card { display: flex; align-items: center; gap: 6px; box-sizing: border-box; height: 34mm;
    padding: 4mm; border: 1px dashed #999; break-inside: avoid; }
  .text { flex: 1; min-width: 0; }
  .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .code { margin: 2px 0; font: 700 18px/1.2 ui-monospace, Menlo, Consolas, monospace; letter-spacing: 1px; }
  .meta, .note { color: #444; font-size: 10.5px; }
  img { width: 24mm; height: 24mm; image-rendering: pixelated; }
  .foot { margin: 4mm 0; color: #666; font-size: 10px; }
</style>
</head>
<body>
<div class="sheet">
${cards}
</div>
<p class="foot">Batch ${escape(sheet.batch)} · ${sheet.codes.length} voucher(s)</p>
</body>
</html>
`;
}

/** The same batch as CSV, for a spreadsheet or a billing system. */
export function voucherSheetCsv(sheet: VoucherSheet): string {
  const cell = (value: string): string =>
    // A leading =, +, - or @ would be run as a formula by a spreadsheet.
    `"${(/^[=+\-@]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;
  return [
    "code,batch,validity,price",
    ...sheet.codes.map((code) =>
      [code, sheet.batch, sheet.validity ?? "", sheet.price ?? ""].map(cell).join(","),
    ),
  ].join("\r\n");
}
