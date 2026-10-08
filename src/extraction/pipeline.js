// Ordered extraction pipeline: QR (bonus) → OCR (workhorse).

import { createLogger } from "../log.js";
import { ExtractionResult, Source } from "./base.js";

const logger = createLogger("pegasus.extraction.pipeline");

/**
 * Runs stages in order and returns the first stage that finds an amount.
 *
 * Stage order is fixed by spec: the QR stage is cheap and exact when it hits,
 * so it runs first — but it misses on ordinary payment slips (see qr.js), and
 * a miss is not an error. OCR is the stage that actually carries this feature.
 */
export class ExtractionPipeline {
  constructor({ qrStage, ocrStage }) {
    this.qrStage = qrStage ?? null;
    this.ocrStage = ocrStage;
  }

  get stageNames() {
    return [...(this.qrStage ? [this.qrStage.name] : []), this.ocrStage.name];
  }

  async run(imageBytes, contentType = "") {
    const notes = [];

    if (this.qrStage) {
      let qrResult;
      try {
        qrResult = await this.qrStage.extract(imageBytes, contentType);
      } catch (error) {
        // Defensive: a QR miss must never 500.
        logger.warning("QR stage raised:", error.message);
        qrResult = ExtractionResult.empty("qr stage error: " + error.message);
      }
      notes.push(...qrResult.notes);
      if (qrResult.found) {
        return new ExtractionResult({
          amount: qrResult.amount,
          source: Source.QR,
          detail: qrResult.detail,
          rawText: qrResult.rawText,
          notes,
        });
      }
      notes.push("qr: " + (qrResult.detail || "no amount"));
    }

    let ocrResult;
    try {
      ocrResult = await this.ocrStage.extract(imageBytes, contentType);
    } catch (error) {
      logger.error("OCR stage raised", error);
      return ExtractionResult.empty("ocr stage error", [...notes, "ocr error: " + error.message]);
    }

    notes.push(...ocrResult.notes);
    if (ocrResult.found) {
      return new ExtractionResult({
        amount: ocrResult.amount,
        source: Source.OCR,
        detail: ocrResult.detail,
        rawText: ocrResult.rawText,
        notes,
      });
    }
    return ExtractionResult.empty(ocrResult.detail || "no amount found", notes);
  }
}
