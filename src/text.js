/* ==========================================================================
   HammerClassify — Textgewinnung (P2)
   - .docx = ZIP: word/document.xml lesen, <w:t>-Knoten zu Text zusammenziehen
   - .zip  = Office-Export: erste .docx-Datei im Paket extrahieren
   - .pdf  = der Browser extrahiert mit pdf.js und schickt den Text mit —
     der Server braucht keine PDF-Library (konzept.md §Datenfluss)
   Keine nativen Abhängigkeiten, kein LibreOffice.
   ========================================================================== */
import JSZip from 'jszip';

/** Häufige XML-Entities entschlüsseln (docx-Text ist XML-escaped). */
export function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeFromCodePoint(cp) {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/**
 * word/document.xml → Volltext.
 * Ein <w:p>-Absatz = eine Zeile; <w:tab/> = Tab, <w:br/> = Zeilenumbruch.
 */
export function extractFromDocumentXml(xml) {
  const lines = [];
  for (const block of xml.split(/<\/w:p>/)) {
    if (!/<w:p[\s>]/.test(block)) continue; // Preamble/Tabellen-Reste ohne Absatz
    let line = '';
    const re = /<w:tab[^>]*\/>|<w:br[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const tok = m[0];
      if (tok.startsWith('<w:tab')) line += '\t';
      else if (tok.startsWith('<w:br')) line += '\n';
      else line += decodeXmlEntities(m[1]);
    }
    lines.push(line);
  }
  return lines
    .map((l) => l.replace(/\t/g, ' ').trimEnd())
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** .docx (Buffer) → Volltext. Leerer String, wenn kein Text drin ist. */
export async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if (!entry) return '';
  return extractFromDocumentXml(await entry.async('string'));
}

/** .zip (Buffer) → Volltext der ersten .docx-Datei darin. */
export async function extractZipText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(/\.docx$/i)[0];
  if (!entry) return '';
  return extractDocxText(await entry.async('nodebuffer'));
}

/**
 * Zip-Struktur prüfen (lädt das Paket vollständig).
 * @returns {string} leer bei gültigem Zip, sonst Fehlermeldung
 */
export async function validateZip(buffer) {
  try {
    await JSZip.loadAsync(buffer);
    return '';
  } catch (e) {
    return `Kein gültiges Zip-Archiv: ${e.message}`;
  }
}
