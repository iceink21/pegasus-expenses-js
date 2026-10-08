// Minimal named logger: "<iso-ts> LEVEL name :: message" on stderr.
// LOG_LEVEL=debug|info|warning|error|silent (default info); the test script
// sets silent so provider-selection warnings do not drown the TAP output.

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, silent: 100 };

function threshold() {
  return LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
}

export function createLogger(name) {
  const emit = (level) => (...parts) => {
    if (LEVELS[level] < threshold()) return;
    const message = parts.map((part) => (part instanceof Error ? part.stack : String(part)));
    process.stderr.write(
      new Date().toISOString() + " " + level.toUpperCase() + " " + name + " :: " +
        message.join(" ") + "\n",
    );
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warning: emit("warning"),
    error: emit("error"),
  };
}
