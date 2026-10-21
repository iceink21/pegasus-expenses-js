// Explicit provider selection, logged loudly at startup.
//
// There is no silent fallback. Every choice is announced, and the chosen names
// are kept on the providers object so /healthz can report exactly what is
// running. Set REQUIRE_REAL_PROVIDERS=1 in production and startup will FAIL
// rather than serve traffic on stubs.

import { ExtractionPipeline } from "./extraction/pipeline.js";
import { LLMAmountExtractor } from "./extraction/llm.js";
import { QRAmountExtractor } from "./extraction/qr.js";
import { StubOCRExtractor } from "./extraction/stub.js";
import { VisionOCRExtractor } from "./extraction/vision.js";
import { createLogger } from "./log.js";
import { NullSlipVerifier } from "./slipverify/null.js";
import { EvidenceFolder } from "./storage/base.js";
import { GoogleDriveStorage } from "./storage/gdrive.js";
import { LocalDiskStorage } from "./storage/local.js";

const logger = createLogger("pegasus.providers");

/** Raised when REQUIRE_REAL_PROVIDERS is set but real credentials are absent. */
export class ProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

function buildLlm(settings, fetchImpl) {
  return new LLMAmountExtractor(settings.openrouterApiKey, {
    model: settings.openrouterModel,
    fetchImpl,
    minConfidence: settings.llmMinConfidence,
    maxAmount: settings.llmMaxAmountThb,
  });
}

/** Returns [ocrStage, fallbackStage, usingStubOcr]. */
function buildOcr(settings, notes, fetchImpl) {
  const llm = settings.openrouterApiKey ? buildLlm(settings, fetchImpl) : null;

  if (settings.googleVisionApiKey) {
    notes.push("GOOGLE_VISION_API_KEY present -> VisionOCRExtractor");
    logger.info("OCR provider: VisionOCRExtractor (Google Cloud Vision)");
    if (llm) {
      notes.push("OPENROUTER_API_KEY present -> LLM fallback after Vision (" + llm.label + ")");
      logger.info("LLM fallback: " + llm.label + " (runs only when Vision finds no amount)");
    }
    return [new VisionOCRExtractor(settings.googleVisionApiKey, { fetchImpl }), llm, false];
  }
  if (llm) {
    notes.push("GOOGLE_VISION_API_KEY absent, OPENROUTER_API_KEY present -> " + llm.label + " as OCR");
    logger.info("OCR provider: LLMAmountExtractor (" + llm.label + ", OpenRouter)");
    return [llm, null, false];
  }
  notes.push(
    "GOOGLE_VISION_API_KEY absent, OPENROUTER_API_KEY absent -> StubOCRExtractor (amounts are SYNTHETIC)",
  );
  logger.warning(
    "OCR provider: Vision and OpenRouter keys absent -> using StubOCRExtractor. " +
      "Extracted amounts are synthetic and must not be trusted.",
  );
  return [new StubOCRExtractor(), null, true];
}

function buildStorage(settings, notes, fetchImpl) {
  if (settings.gdriveSaJson && settings.gdriveFolderId) {
    try {
      const storage = new GoogleDriveStorage(settings.gdriveSaJson, settings.gdriveFolderId, {
        fetchImpl,
        folderOverrides: {
          [EvidenceFolder.VERIFIED]: settings.gdriveFolderVerified,
          [EvidenceFolder.NEEDS_REVIEW]: settings.gdriveFolderReview,
          [EvidenceFolder.REJECTED]: settings.gdriveFolderRejected,
        },
      });
      notes.push("GDRIVE_SA_JSON + GDRIVE_FOLDER_ID present -> GoogleDriveStorage");
      logger.info("Evidence storage: GoogleDriveStorage (Shared Drive service account)");
      return [storage, false];
    } catch (error) {
      // Bad credentials are a configuration bug. Never degrade quietly.
      notes.push("GoogleDriveStorage init failed: " + error.message);
      logger.error("Evidence storage: Drive credentials rejected:", error.message);
      if (settings.requireRealProviders) {
        throw new ProviderConfigError(
          "REQUIRE_REAL_PROVIDERS=1 but Drive credentials failed: " + error.message,
        );
      }
      logger.warning("Evidence storage: falling back to LocalDiskStorage");
      return [new LocalDiskStorage(settings.localUploadDir), true];
    }
  }

  if (settings.gdriveSaJson && !settings.gdriveFolderId) {
    notes.push("GDRIVE_SA_JSON set but GDRIVE_FOLDER_ID missing -> LocalDiskStorage");
    logger.warning("Evidence storage: GDRIVE_FOLDER_ID missing -> LocalDiskStorage");
  } else {
    notes.push("GDRIVE_SA_JSON absent -> LocalDiskStorage (data/uploads)");
    logger.warning(
      "Evidence storage: Drive service account absent -> using LocalDiskStorage at " +
        settings.localUploadDir,
    );
  }
  return [new LocalDiskStorage(settings.localUploadDir), true];
}

export function buildProviders(settings, { fetchImpl = fetch } = {}) {
  const notes = [];

  const [ocrStage, fallbackStage, usingStubOcr] = buildOcr(settings, notes, fetchImpl);
  const [storage, usingStubStorage] = buildStorage(settings, notes, fetchImpl);

  if (settings.requireRealProviders && (usingStubOcr || usingStubStorage)) {
    const missing = [];
    if (usingStubOcr) missing.push("GOOGLE_VISION_API_KEY or OPENROUTER_API_KEY");
    if (usingStubStorage) missing.push("GDRIVE_SA_JSON/GDRIVE_FOLDER_ID");
    const message =
      "REQUIRE_REAL_PROVIDERS=1 but stub providers were selected. Missing: " + missing.join(", ");
    logger.error(message);
    throw new ProviderConfigError(message);
  }

  let qrStage = null;
  if (settings.enableQrStage) {
    qrStage = new QRAmountExtractor();
    notes.push("QR stage enabled (bonus only; slip QRs rarely carry an amount)");
  } else {
    notes.push("QR stage disabled by ENABLE_QR_STAGE=0");
  }

  const slipVerifier = new NullSlipVerifier();
  notes.push("Slip verification: NullSlipVerifier (out of scope for v1)");

  const pipeline = new ExtractionPipeline({ qrStage, ocrStage, fallbackStage });
  const llmStage = fallbackStage ?? (ocrStage instanceof LLMAmountExtractor ? ocrStage : null);
  const llmRole = llmStage ? (fallbackStage ? "fallback" : "primary") : null;
  for (const note of notes) logger.info("provider selection:", note);

  return Object.freeze({
    pipeline,
    storage,
    slipVerifier,
    ocrStage,
    usingStubOcr,
    usingStubStorage,
    startupNotes: notes,
    describe() {
      return {
        ocr: ocrStage.name,
        storage: storage.name,
        slip_verifier: slipVerifier.name,
        extraction_stages: pipeline.stageNames,
        llm_model: llmStage ? llmStage.model : null,
        llm_role: llmRole,
        using_stub_ocr: usingStubOcr,
        using_stub_storage: usingStubStorage,
        notes,
      };
    },
  });
}
