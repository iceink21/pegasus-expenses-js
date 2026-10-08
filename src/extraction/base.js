// Extraction interfaces.
//
// An amount extractor is any object with
//     name: string
//     extract(imageBytes: Buffer, contentType?: string): Promise<ExtractionResult>
// Implementations:
//   - QRAmountExtractor    (qr.js)     — opportunistic, see the note there
//   - VisionOCRExtractor   (vision.js) — the real workhorse
//   - StubOCRExtractor     (stub.js)   — local, no credentials
//   - LLMAmountExtractor   (llm.js)    — OpenRouter vision model; primary when
//                                        Vision is absent, otherwise fallback

/** Where an amount came from. Stored on the expense row. */
export const Source = Object.freeze({ QR: "qr", OCR: "ocr", LLM: "llm", NONE: "none" });

export class ExtractionResult {
  constructor({
    amount,
    source = Source.NONE,
    detail = "",
    rawText = "",
    notes = [],
    extractor = "",
    confidence = null,
  }) {
    this.amount = amount ?? null;
    this.source = source;
    this.detail = detail;
    this.rawText = rawText;
    this.notes = [...notes];
    // Which extractor produced the amount, e.g. "VisionOCRExtractor" or
    // "llm:google/gemini-2.5-flash-lite". Stored in the audit detail.
    this.extractor = extractor;
    // 0..1 when the stage can judge its own reading; null means "no opinion"
    // (rule-based stages), which the pipeline treats as confident.
    this.confidence = confidence;
    Object.freeze(this);
  }

  get found() {
    return this.amount !== null;
  }

  static empty(detail = "", notes = []) {
    return new ExtractionResult({ amount: null, source: Source.NONE, detail, notes });
  }
}
