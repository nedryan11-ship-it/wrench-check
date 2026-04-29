export async function extractPdfText(buffer: Buffer, _filename?: string): Promise<string> {
  try {
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.js");
    pdfjs.GlobalWorkerOptions.workerSrc = "";

    const doc: any = await Promise.race([
      pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false, disableFontFace: true }).promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("Local extraction timeout (5s)")), 5000)),
    ]);

    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const str = content.items.map((item: any) => item.str).join(" ");
      pageTexts.push(str);
    }
    return pageTexts.join("\n");
  } catch (err) {
    console.error("PDF Parsing failed:", err);
    return "";
  }
}
