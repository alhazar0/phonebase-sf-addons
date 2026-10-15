/** Known OCR confusion of a magnifying-glass glyph, not fuzzy app-name matching. */
export function canonicalLabel(text:string):string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g," ").trim()
    .replace(/^[<‹›>←]\s*(?=\p{L}{2})/u,"")
    .replace(/^q (app library|search|应用资源库|搜索)$/,"$1");
}
