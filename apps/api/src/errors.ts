import type { ErrorRequestHandler } from "express";
import multer from "multer";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    response.status(tooLarge ? 413 : 400).json({
      error: {
        code: tooLarge ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD",
        message: tooLarge ? "Audio file exceeds the 10 MB limit." : "The audio upload is invalid.",
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues },
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  console.error("Unhandled API error", error);
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
};
