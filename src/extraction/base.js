// Extraction interfaces.
//
// An amount extractor is any object with
//     name: string
//     extract(imageBytes: Buffer, contentType?: string): Promise<ExtractionResult>
// Implementations:
//   - QRAmountExtractor    (qr.js)     — opportunistic, see the note there
//   - VisionOCRExtractor   (vision.js) — the real workhorse
//   - StubOCRExtractor     (stub.js)   — local, no credentials

/** Where an amount came from. Stored on the expense row. */
export const Source = Object.freeze({ QR: "qr", OCR: "ocr", NONE: "none" });

export class ExtractionResult {
  constructor({ amount, source = Source.NONE, detail = "", rawText = "", notes = [] }) {
    this.amount = amount ?? null;
    this.source = source;
    this.detail = detail;
    this.rawText = rawText;
    this.notes = [...notes];
    Object.freeze(this);
  }

  get found() {
    return this.amount !== null;
  }

  static empty(detail = "", notes = []) {
    return new ExtractionResult({ amount: null, source: Source.NONE, detail, notes });
  }
}
