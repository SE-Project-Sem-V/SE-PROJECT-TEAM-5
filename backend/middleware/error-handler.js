const { AppError, httpErrorResponse, sendHttpError } = require("../errors");
const { logFailure } = require("../logging");
const express = require("express");

const PARSER_ERRORS = new Map([
  ["entity.parse.failed", "INVALID_JSON"],
  ["entity.too.large", "PAYLOAD_TOO_LARGE"],
  ["charset.unsupported", "UNSUPPORTED_ENCODING"],
  ["encoding.unsupported", "UNSUPPORTED_ENCODING"],
  ["request.aborted", "INVALID_INPUT"],
  ["request.size.invalid", "INVALID_INPUT"],
]);

function createJsonParser() {
  const parse = express.json();
  return (req, res, next) => parse(req, res, error => {
    if (!error) return next();
    // Only errors originating at the parser boundary may select parser codes.
    next(new AppError(PARSER_ERRORS.get(error.type) || "INTERNAL_ERROR"));
  });
}

function createHttpErrorHandler(logger = console) {
  return function httpErrorHandler(error, _req, res, _next) {
    const { status, body } = httpErrorResponse(error);
    // All logged values are controlled here. Raw errors may contain a complete
    // request body, SQL details, authorization headers or credential fragments.
    logFailure(logger, "http.request.failed", body.code, { status });
    if (res.headersSent) {
      // Passing the original error to Express would invoke its unsafe logger.
      res.destroy();
      return;
    }
    res.status(status).json(body);
  };
}

function notFound(_req, res) {
  // Express's default 404 can echo a credential accidentally placed in a URL.
  return sendHttpError(res, new AppError("NOT_FOUND"));
}

module.exports = { createHttpErrorHandler, createJsonParser, notFound };
