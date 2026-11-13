/* ==========================================================================
   HammerClassify — Textgewinnung (P2, seit P4 auch serverseitig)
   - .docx = ZIP: word/document.xml lesen, <w:t>-Knoten zu Text zusammenziehen
   - .zip  = Office-Export: erste .docx-Datei im Paket extrahieren
   - .pdf  = Upload: der Browser extrahiert mit pdf.js; Scan: pdfjs-dist
     (Legacy-Build) serverseitig — keine nativen Abhängigkeiten
   - .doc  = binäres Word: optional via LibreOffice (soffice), wenn installiert
   ========================================================================== */
import JSZip from 'jszip';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';

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

/**
 * .pdf (Buffer) → Volltext, serverseitig (pdfjs-dist, Legacy-Build für Node).
 * Nur für den Scan nötig: Uploads extrahiert der Browser. Die Zeilenlogik
 * spiegelt die des Browsers (app.js pageText): hasEOL + Y-Sprung = neue Zeile.
 */
export async function extractPdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let loadingTask;
  let doc;
  try {
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    doc = await loadingTask.promise;
  } catch {
    return ''; // defektes PDF → „kein_text“ → manuell (kein Crash)
  }
  const lines = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const { items } = await page.getTextContent();
      let cur = '';
      let lastY = null;
      const flush = () => {
        const l = cur.trim();
        if (l) lines.push(l);
        cur = '';
      };
      for (const it of items) {
        if (it.str) {
          const y = it.transform ? it.transform[5] : null;
          if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) flush();
          cur += it.str;
          lastY = y ?? lastY;
        }
        // hasEOL = „nach diesem Text folgt ein Zeilenumbruch“: str erst
        // anhängen, dann die Zeile abschließen. (Vorher: flush+continue →
        // Text ging verloren, z. B. Namen/Adressen in Apple-Rechnungen.)
        if (it.hasEOL) { flush(); lastY = null; }
      }
      flush();
    }
  } finally {
    // pdf.js v6: destroy() liegt auf der LoadingTask, nicht auf dem
    // PDFDocumentProxy (doc.destroy() wäre ein TypeError).
    await loadingTask.destroy().catch(() => {});
  }
  return lines.join('\n').trim();
}

/* .doc (binäres Word): braucht LibreOffice. Wenn `soffice` nicht installiert
   ist (Standard auf dem Pi), liefert die Funktion '' — das Dokument landet
   in „manuell" (konzept.md Offener Punkt 4: selten → wartet auf OCR/V2). */

let sofficePfadCache;
export function sofficePfad() {
  if (sofficePfadCache !== undefined) return sofficePfadCache;
  try {
    sofficePfadCache = execFileSync('which', ['soffice'], { encoding: 'utf8' }).trim() || null;
  } catch {
    sofficePfadCache = null;
  }
  return sofficePfadCache;
}

export async function extractDocText(buffer, tmpDir) {
  const pfad = sofficePfad();
  if (!pfad) return '';
  const { spawn } = await import('node:child_process');
  const work = mkdtempSync(path.join(tmpDir, 'soffice-'));
  const src = path.join(work, 'input.doc');
  writeFileSync(src, buffer, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(pfad, ['--headless', '--convert-to', 'txt:Text', '--outdir', work, src], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
      p.on('error', reject);
      p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`soffice Exit ${code}`)); });
    });
    return readFileSync(path.join(work, 'input.txt'), 'utf8').trim();
  } catch {
    return ''; // defekte .doc → manuell
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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
