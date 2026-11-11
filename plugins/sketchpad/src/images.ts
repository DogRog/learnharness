/** Images already present in the session's messages, read from the public
 * session view only. Nothing is fetched and no file path is opened. */
export type SessionImage = { key: string; label: string } & ({ kind: "bitmap"; mimeType: string; data: string } | { kind: "figure"; svg: string });
export const SESSION_IMAGE_LIMIT = 12;
const BITMAP_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function blocks(value: unknown): { mimeType: string; data: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const block = object(entry);
    return block && block.type === "image" && typeof block.data === "string" && block.data && typeof block.mimeType === "string" &&
      BITMAP_TYPES.has(block.mimeType) ? [{ mimeType: block.mimeType, data: block.data }] : [];
  });
}
/** Newest first, without duplicates, at most SESSION_IMAGE_LIMIT entries.
 * Learner images: native image blocks in messages, answers and practice thinking.
 * Tutor figures: delivered visual results that are a complete SVG (figures that
 * annotate a learner photo need a host snapshot and are left out). */
export function sessionImages(messages: readonly unknown[]): SessionImage[] {
  const found: SessionImage[] = [], seen = new Set<string>();
  let images = 0, figures = 0;
  const bitmap = (owner: "learner" | "session", block: { mimeType: string; data: string }) => {
    const identity = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 64)}:${block.data.slice(-64)}`;
    if (seen.has(identity)) return;
    seen.add(identity); images++;
    found.push({ kind: "bitmap", key: `image-${images}`, label: owner === "learner" ? `Your image ${images}` : `Session image ${images}`, ...block });
  };
  for (const value of messages) {
    const message = object(value);
    if (!message) continue;
    if (message.role === "user") for (const block of blocks(message.content)) bitmap("learner", block);
    else if (message.role === "toolResult") for (const block of blocks(message.content)) bitmap("session", block);
    else if (message.role === "custom") {
      const details = object(message.details);
      if (!details) continue;
      const channels = object(details.images);
      for (const block of [...blocks(details.images), ...blocks(channels?.submission), ...blocks(channels?.thinking)]) bitmap("learner", block);
      const result = object(details.result);
      if (message.customType === "subagent-steer" && details.kind === "visual" && result && typeof result.svg === "string" &&
        /<svg[\s>]/i.test(result.svg) && !result.image && !seen.has(result.svg)) {
        seen.add(result.svg); figures++;
        found.push({ kind: "figure", key: `figure-${figures}`, label: `Tutor figure ${figures}`, svg: result.svg });
      }
    }
  }
  return found.reverse().slice(0, SESSION_IMAGE_LIMIT);
}

/** Make a stored figure decodable as an image: a namespace and an explicit
 * pixel size (from width/height, else the viewBox) on the root element. */
export function figureMarkup(svg: string): { svg: string; width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) throw new Error("This figure is not an SVG image.");
  const tag = root[0];
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1]?.trim();
  const pixels = (value: string | undefined) => {
    const match = value === undefined ? null : /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value);
    return match && Number(match[1]) > 0 ? Number(match[1]) : undefined;
  };
  const box = attribute("viewBox")?.split(/[\s,]+/).map(Number);
  const boxed = box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0 ? { width: box[2]!, height: box[3]! } : undefined;
  let width = pixels(attribute("width")), height = pixels(attribute("height"));
  if (width === undefined || height === undefined) {
    if (boxed && width !== undefined) height = width * boxed.height / boxed.width;
    else if (boxed && height !== undefined) width = height * boxed.width / boxed.height;
    else { width = boxed?.width ?? 800; height = boxed?.height ?? 600; }
  }
  let next = tag.replace(/\s(?:width|height)\s*=\s*(["'])[^"']*\1/gi, "").replace(/\/?>$/, end => ` width="${width}" height="${height}"${end}`);
  if (!/\sxmlns\s*=/.test(next)) next = next.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return { svg: svg.slice(0, root.index) + next + svg.slice(root.index + tag.length), width: width!, height: height! };
}
