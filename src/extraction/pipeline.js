// Ordered extraction pipeline: QR (bonus) → OCR (workhorse) → LLM (fallback).

import { createLogger } from "../log.js";
import { ExtractionResult, Source } from "./base.js";

const logger = createLogger("pegasus.extraction.pipeline");

/** An OCR reading below this self-reported confidence asks the fallback stage. */
export const LOW_CONFIDENCE_BELOW = 0.5;

function isLowConfidence(result) {
  return typeof result.confidence === "number" && result.confidence < LOW_CONFIDENCE_BELOW;
}

/**
 * Runs stages in order and returns the first stage that finds an amount.
 *
 * Stage order is fixed by spec: the QR stage is cheap and exact when it hits,
 * so it runs first — but it misses on ordinary payment slips (see qr.js), and
 * a miss is not an error. OCR is the stage that actually carries this feature.
 *
 * The optional fallback stage (the LLM extractor, when Vision is the OCR stage)
 * runs only when OCR found nothing or flagged its own reading as low
 * confidence. It receives the OCR text as a hint. A fallback miss never
 * discards an OCR reading that did exist.
 */
export class ExtractionPipeline {
  constructor({ qrStage, ocrStage, fallbackStage = null }) {
    this.qrStage = qrStage ?? null;
    this.ocrStage = ocrStage;
    this.fallbackStage = fallbackStage;
  }

  get stageNames() {
    return [
      ...(this.qrStage ? [this.qrStage.name] : []),
      this.ocrStage.name,
      ...(this.fallbackStage ? [this.fallbackStage.name] : []),
    ];
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
          extractor: qrResult.extractor || this.qrStage.name,
          confidence: qrResult.confidence,
        });
      }
      notes.push("qr: " + (qrResult.detail || "no amount"));
    }

    let ocrResult;
    try {
      ocrResult = await this.ocrStage.extract(imageBytes, contentType);
    } catch (error) {
      logger.error("OCR stage raised", error);
      ocrResult = ExtractionResult.empty("ocr stage error", ["ocr error: " + error.message]);
    }
    notes.push(...ocrResult.notes);

    // The OCR stage may itself be the LLM (primary mode); keep its source.
    const ocrSource = ocrResult.source === Source.LLM ? Source.LLM : Source.OCR;
    const ocrHit = ocrResult.found
      ? new ExtractionResult({
          amount: ocrResult.amount,
          source: ocrSource,
          detail: ocrResult.detail,
          rawText: ocrResult.rawText,
          notes,
          extractor: ocrResult.extractor || this.ocrStage.name,
          confidence: ocrResult.confidence,
        })
      : null;

    if (ocrHit && !(this.fallbackStage && isLowConfidence(ocrResult))) return ocrHit;
    if (!this.fallbackStage) {
      return ocrHit ?? ExtractionResult.empty(ocrResult.detail || "no amount found", notes);
    }

    notes.push(
      ocrHit
        ? "ocr: low confidence " + ocrResult.confidence + ", asking fallback"
        : "ocr: " + (ocrResult.detail || "no amount") + ", asking fallback",
    );

    let fallbackResult;
    try {
      fallbackResult = await this.fallbackStage.extract(imageBytes, contentType, {
        ocrText: ocrResult.rawText || "",
      });
    } catch (error) {
      // The LLM extractor never throws by contract; this is belt and braces.
      logger.error("fallback stage raised", error);
      fallbackResult = ExtractionResult.empty("fallback stage error", [
        "fallback error: " + error.message,
      ]);
    }
    notes.push(...fallbackResult.notes);

    if (fallbackResult.found) {
      return new ExtractionResult({
        amount: fallbackResult.amount,
        source: fallbackResult.source === Source.NONE ? Source.LLM : fallbackResult.source,
        detail: fallbackResult.detail,
        rawText: ocrResult.rawText || fallbackResult.rawText,
        notes,
        extractor: fallbackResult.extractor || this.fallbackStage.name,
        confidence: fallbackResult.confidence,
      });
    }
    if (ocrHit) {
      return new ExtractionResult({ ...ocrHit, notes: [...notes, "fallback: no amount, kept OCR"] });
    }
    return ExtractionResult.empty(
      fallbackResult.detail || ocrResult.detail || "no amount found",
      notes,
    );
  }
}
