import type { PluginSubmission, PluginSubmissionInterceptor } from "learnharness-plugin-api";
import type { Capture, Sheets } from "./state.ts";

export interface SketchImage { type: "image"; mimeType: "image/png"; data: string }

/** Append to the existing native channel. Never change text, selections, JSON
 * or images that are already there (for example a Drawing Pad image). */
export function appendSketch(input: PluginSubmission, image: SketchImage): PluginSubmission {
  switch (input.type) {
    case "text": case "thinking": return { ...input, content: { ...input.content, images: [...input.content.images, image] } };
    case "answer": return { ...input, answer: { ...input.answer, images: [...input.answer.images, image] } };
    case "plugin-question-answer": return { ...input, answerImages: [...input.answerImages, image] };
    case "plugin-problem-submission": return { ...input, submissionImages: [...input.submissionImages, image] };
  }
}
export interface InterceptorDeps {
  sheets: Sheets;
  /** Commit a stroke that is still under the pen before the snapshot is taken. */
  flush(sessionId: string): void;
  exportImage(captured: Capture, signal: AbortSignal): SketchImage | Promise<SketchImage>;
  /** False once the plugin activation has ended. */
  active(): boolean;
}
/** Attach the session's sketch to the learner's next content submission.
 * Only a host-acknowledged acceptance consumes it: a failed, refused or
 * cancelled attempt leaves the sheet exactly as it was. */
export function createSubmissionInterceptor({ sheets, flush, exportImage, active }: InterceptorDeps): PluginSubmissionInterceptor {
  return {
    id: "sketch", priority: 0,
    hasPendingInput(target) {
      const state = sheets.sessions.get(target.sessionId);
      if (!state || !sheets.pending(state)) return false;
      return target.type === "text" || target.type === "thinking" || (target.type === "answer" && target.question.mode === "text");
    },
    async intercept(input, context) {
      const state = sheets.sessions.get(context.sessionId);
      if (!state) return;
      context.signal.throwIfAborted();
      flush(state.id);
      const captured = sheets.capture(state);
      if (!captured.sendImage) return;
      const image = await exportImage(captured, context.signal);
      context.signal.throwIfAborted();
      if (state.draft.id !== captured.draft.id) throw new Error("The sketch was replaced while it was being prepared. Review it and submit again.");
      context.onAccepted(() => { if (active()) sheets.accepted(captured); });
      return appendSketch(input, image);
    },
  };
}
