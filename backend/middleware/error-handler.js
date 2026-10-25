const PARSER_ERRORS = new Map([
  ["entity.parse.failed", [400, "Invalid JSON request."]],
  ["entity.too.large", [413, "Request body is too large."]],
  ["charset.unsupported", [415, "Unsupported request encoding."]],
  ["encoding.unsupported", [415, "Unsupported request encoding."]],
  ["request.aborted", [400, "Invalid request."]],
  ["request.size.invalid", [400, "Invalid request."]],
]);

function createHttpErrorHandler(logger = console) {
  return function httpErrorHandler(error, _req, res, _next) {
    const [status, message] = PARSER_ERRORS.get(error?.type) || [500, "Internal server error."];
    // All logged values are controlled here. Raw errors may contain a complete
    // request body, SQL details, authorization headers or credential fragments.
    logger.error("[http] Request failed:", status);
    if (res.headersSent) {
      // Passing the original error to Express would invoke its unsafe logger.
      res.destroy();
      return;
    }
    res.status(status).json({ status: "error", message });
  };
}

function notFound(_req, res) {
  // Express's default 404 can echo a credential accidentally placed in a URL.
  res.status(404).json({ status: "error", message: "Not found." });
}

module.exports = { createHttpErrorHandler, notFound };
