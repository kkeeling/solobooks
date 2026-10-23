import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { InvoiceDocument } from "./documents.ts";
import { dollars, longDate, percent } from "./format.ts";

// Renders an invoice or credit note from its document model. pdf-lib and its built-in Helvetica only:
// no browser, no system fonts. The same model and timestamp always give the same bytes.

const W = 612; // US Letter, in points
const H = 792;
const M = 54;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);

export async function renderPdf(doc: InvoiceDocument, createdAt: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const title = doc.kind === "credit" ? "Credit note" : "Invoice";
  const when = new Date(createdAt);
  pdf.setTitle(doc.draft ? `Draft ${title.toLowerCase()}` : `${title} ${doc.number}`);
  pdf.setAuthor(clean(doc.seller.legal_name ?? "", regular));
  pdf.setProducer("solobooks");
  pdf.setCreator("solobooks");
  pdf.setCreationDate(when);
  pdf.setModificationDate(when);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([W, H]);
    pages.push(page);
    // Drawn first so it sits behind the text.
    if (doc.draft) page.drawText("DRAFT", { x: 150, y: 260, size: 120, font: bold, color: rgb(0.9, 0.9, 0.9), rotate: degrees(35) });
    y = H - M;
  };
  const text = (s: string, x: number, size = 10, font = regular, color = INK) => page.drawText(clean(s, font), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 10, font = regular) => {
    const c = clean(s, font);
    page.drawText(c, { x: xRight - font.widthOfTextAtSize(c, size), y, size, font, color: INK });
  };
  const need = (h: number) => {
    if (y - h < M + 20) newPage();
  };

  newPage();
  // Seller, top left.
  text(doc.seller.legal_name ?? "", M, 16, bold);
  y -= 18;
  for (const l of lines(doc.seller.address)) {
    text(l, M, 10, regular, MUTED);
    y -= 13;
  }
  if (doc.seller.ein) {
    text(`EIN ${doc.seller.ein}`, M, 10, regular, MUTED);
    y -= 13;
  }
  if (doc.seller.email) {
    text(doc.seller.email, M, 10, regular, MUTED);
    y -= 13;
  }
  const leftBottom = y;

  // Title and facts, top right.
  y = H - M;
  right(doc.draft ? `DRAFT ${title.toUpperCase()}` : title.toUpperCase(), W - M, 20, bold);
  y -= 24;
  const label = doc.kind === "credit" ? "Credit note number" : "Invoice number";
  const facts: string[] = [doc.draft ? `${label}: assigned when issued` : `${label}: ${doc.number}`];
  if (doc.credits_number) facts.push(`Credits invoice: ${doc.credits_number}`);
  facts.push(`${doc.kind === "credit" ? "Date" : "Invoice date"}: ${doc.invoice_date ? longDate(doc.invoice_date) : "set when issued"}`);
  facts.push(`Service period: ${longDate(doc.period_start)} – ${longDate(doc.period_end)}`);
  if (doc.terms) facts.push(`Terms: ${doc.terms}`);
  if (doc.kind === "invoice") facts.push(`Due date: ${doc.due_date ? longDate(doc.due_date) : "set when issued"}`);
  for (const f of facts) {
    right(f, W - M);
    y -= 13;
  }

  // Bill to.
  y = Math.min(y, leftBottom) - 20;
  text(doc.kind === "credit" ? "Credit to" : "Bill to", M, 9, bold, MUTED);
  y -= 14;
  text(doc.client.name, M, 11, bold);
  y -= 14;
  for (const l of lines(doc.client.address)) {
    text(l, M);
    y -= 13;
  }

  // Lines.
  y -= 18;
  const amountRight = W - M;
  const descWidth = W - 2 * M - 110;
  const header = () => {
    text("Description", M, 9, bold, MUTED);
    right("Amount", amountRight, 9, bold);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: MUTED });
    y -= 14;
  };
  header();
  for (const l of doc.lines) {
    const wrapped = wrap(clean(l.description, regular), regular, 10, descWidth);
    need(wrapped.length * 13 + 4);
    if (y === H - M) header();
    right(dollars(l.amount_cents), amountRight);
    for (const w of wrapped) {
      text(w, M);
      y -= 13;
    }
    y -= 4;
  }

  // Totals.
  need(80);
  page.drawLine({ start: { x: W - M - 220, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: MUTED });
  y -= 8;
  const row = (name: string, cents: number, font = regular, size = 10) => {
    right(name, W - M - 110, size, font);
    right(dollars(cents), amountRight, size, font);
    y -= size + 5;
  };
  row("Subtotal", doc.subtotal_cents);
  if (doc.tax) row(`${doc.tax.label} (${percent(doc.tax.rate_ppm)})`, doc.tax.amount_cents);
  row(doc.kind === "credit" ? "Total credit" : "Total due", doc.total_cents, bold, 12);

  // Payment instructions and note.
  const block = (heading: string, body: string | null) => {
    if (!body) return;
    const ls = lines(body).flatMap((l) => wrap(clean(l, regular), regular, 10, W - 2 * M));
    need(ls.length * 13 + 30);
    y -= 16;
    text(heading, M, 9, bold, MUTED);
    y -= 14;
    for (const l of ls) {
      text(l, M);
      y -= 13;
    }
  };
  if (doc.kind === "invoice") block("How to pay", doc.payment_instructions);
  block(doc.kind === "credit" ? "Reason" : "Note", doc.note);

  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const s = `Page ${i + 1} of ${pages.length}`;
      p.drawText(s, { x: W - M - regular.widthOfTextAtSize(s, 8), y: M - 20, size: 8, font: regular, color: MUTED });
    });
  }
  return pdf.save();
}

function lines(s: string | null): string[] {
  return s ? s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}

const charsets = new WeakMap<PDFFont, Set<number>>();

/** Standard fonts only cover Windows-1252, so anything else prints as "?" instead of failing the render. */
function clean(s: string, font: PDFFont): string {
  let set = charsets.get(font);
  if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
  let out = "";
  for (const ch of s.replace(/\t/g, " ")) out += set.has(ch.codePointAt(0)!) ? ch : "?";
  return out;
}

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !cur) cur = next;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}
