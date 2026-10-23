import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ROOT } from "./books.ts";

const FONTS = join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + "/";

/** The text of a PDF as printed lines: pieces on the same baseline, left to right, joined by a space. */
export async function pdfLines(path: string): Promise<string[]> {
  const task = getDocument({ data: new Uint8Array(readFileSync(path)), standardFontDataUrl: FONTS });
  const pdf = await task.promise;
  const out: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = (await (await pdf.getPage(p)).getTextContent()).items as { str: string; transform: number[] }[];
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of items) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5]!);
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4]!, s: it.str }]);
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      out.push(rows.get(y)!.sort((a, b) => a.x - b.x).map((r) => r.s).join(" "));
    }
  }
  await task.destroy();
  return out;
}
