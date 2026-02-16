import { getTraceStore } from "../../../tracing/store";

export const handlers = {
  "errors.list"(input: { limit?: number; cursor?: string }) {
    if (input.limit !== undefined && (typeof input.limit !== "number" || input.limit < 1)) {
      throw new Error("limit must be a positive number");
    }
    return getTraceStore().listErrors({ limit: input.limit ?? 50, cursor: input.cursor });
  },

  "errors.get"(input: { id: string }) {
    if (!input.id || typeof input.id !== "string") {
      throw new Error("id is required and must be a string");
    }
    const error = getTraceStore().getError(input.id);
    if (!error) throw new Error("Error not found");
    return error;
  },

  "errors.delete"(input: { id: string }): { ok: true } {
    if (!input.id || typeof input.id !== "string") {
      throw new Error("id is required and must be a string");
    }
    getTraceStore().deleteError(input.id);
    return { ok: true };
  },

  "errors.clear"(_input: {}): { ok: true } {
    getTraceStore().clearErrors();
    return { ok: true };
  },
};
