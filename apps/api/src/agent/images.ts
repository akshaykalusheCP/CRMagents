import { z } from 'zod';

// Images people attach to a question (a screenshot of an error, a photo of a damaged part, a business card), and
// images read from Salesforce files. They go to the AI as they are: text inside an image can't be masked.

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** The AI providers' own limit per image. The app and the Salesforce panel shrink photos well below it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 4;

export const imageSchema = z.object({
  mediaType: z.enum(IMAGE_TYPES),
  /** Base64, without a data: prefix. */
  data: z.string().min(16).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Image data must be base64'),
  name: z.string().max(200).optional(),
});
export type ImageInput = z.infer<typeof imageSchema>;
export const imagesSchema = z.array(imageSchema).max(MAX_IMAGES, `Attach at most ${MAX_IMAGES} images`).optional();

/** Request bodies that may carry images need room for them (base64 is a third bigger than the file). */
export const IMAGE_BODY_LIMIT = MAX_IMAGES * Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1_000_000;

const sniff = (b: Buffer): ImageType | null => {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
};

/** Checks each image really is the kind of image it says, and isn't too big. Throws a 400 otherwise. Pure; tested. */
export function checkImages(images: ImageInput[] | undefined): ImageInput[] {
  const out: ImageInput[] = [];
  for (const [i, img] of (images ?? []).entries()) {
    const bytes = Buffer.from(img.data, 'base64');
    const label = img.name ? `"${img.name}"` : `Image ${i + 1}`;
    if (bytes.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(`${label} is larger than 5 MB.`), { statusCode: 400 });
    const real = sniff(bytes);
    if (!real) throw Object.assign(new Error(`${label} isn't a JPEG, PNG, GIF or WebP image.`), { statusCode: 400 });
    out.push({ ...img, mediaType: real });
  }
  return out;
}

/** Messages API content blocks: images first, then the text (what the providers recommend). */
export const imageBlocks = (images: ImageInput[]) =>
  images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } }));

/** How an image shows in a saved conversation (the image itself isn't kept). Pure; tested. */
export const imageNote = (images: ImageInput[] | undefined) =>
  images?.length ? `\n[${images.length === 1 ? `Image: ${images[0].name ?? 'attached'}` : `${images.length} images: ${images.map((i, n) => i.name ?? `image ${n + 1}`).join(', ')}`}]` : '';

export const imageFromExtension = (ext: string): ImageType | null =>
  ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' } as Record<string, ImageType>)[ext.toLowerCase()] ?? null;

/** A tool returns { [IMAGE_RESULT]: image } to show the AI an image instead of text. */
export const IMAGE_RESULT = '__image';
export const isImageResult = (v: unknown): v is { __image: ImageInput } => !!v && typeof v === 'object' && IMAGE_RESULT in (v as object);
