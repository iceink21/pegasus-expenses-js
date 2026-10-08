// Google Cloud Vision OCR — the primary amount source.
//
// Uses the REST endpoint with an API key so no service-account plumbing is
// needed for OCR (Drive uses a service account; Vision only needs
// GOOGLE_VISION_API_KEY). Activated only when that env var is present;
// otherwise providers.js selects the stub and says so at startup.

import { createLogger } from "../log.js";
import { findAmount } from "./amount-text.js";
import { ExtractionResult, Source } from "./base.js";

const logger = createLogger("pegasus.extraction.vision");

export const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const REQUEST_TIMEOUT_MS = 20_000;

export class VisionOCRExtractor {
  name = "VisionOCRExtractor";

  constructor(apiKey, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error("VisionOCRExtractor requires an API key");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async callVision(imageBytes) {
    const body = {
      requests: [
        {
          image: { content: Buffer.from(imageBytes).toString("base64") },
          features: [{ type: "TEXT_DETECTION" }],
          // Thai first, English fallback for latin numerals/labels.
          imageContext: { languageHints: ["th", "en"] },
        },
      ],
    };
    // The key goes in the X-Goog-Api-Key HEADER, never in the query string:
    // full URLs end up in proxy logs, crash reports, and stack traces, and a
    // leaked key there is a leaked key. The header form is the documented
    // equivalent of ?key=.
    const response = await this.fetchImpl(VISION_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error("vision HTTP " + response.status);
    const payload = await response.json();

    const first = (payload.responses ?? [{}])[0] ?? {};
    if (first.error) throw new Error(String(first.error.message ?? "vision error"));
    const annotation = first.fullTextAnnotation ?? {};
    if (annotation.text) return String(annotation.text);
    const texts = first.textAnnotations ?? [];
    return texts.length > 0 ? String(texts[0].description ?? "") : "";
  }

  async extract(imageBytes) {
    let text;
    try {
      text = await this.callVision(imageBytes);
    } catch (error) {
      logger.warning("Vision OCR call failed:", error.message);
      // A provider outage is UNREADABLE, never a fraud signal.
      return ExtractionResult.empty("vision call failed", ["vision error: " + error.message]);
    }

    const { amount, detail } = findAmount(text);
    if (amount === null) return ExtractionResult.empty(detail, ["vision returned text but no amount"]);
    return new ExtractionResult({ amount, source: Source.OCR, detail, rawText: text });
  }
}
