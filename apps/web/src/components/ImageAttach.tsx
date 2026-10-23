import { ImagePlus, X } from 'lucide-react';
import { useRef } from 'react';
import { toast } from './ui';

// Images attached to a question: picked, pasted (Ctrl+V) or dropped. Photos are shrunk in the browser to what the
// AI needs (longest side 1568 px), which keeps uploads small and AI costs low.

export interface PickedImage { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string; name: string; preview: string }
export const MAX_IMAGES = 4;
const MAX_SIDE = 1568;
const OK = /^image\/(jpeg|png|gif|webp)$/;

/** Longest side capped; PNG kept for screenshots (sharp text), JPEG for photos. */
async function shrink(file: File): Promise<PickedImage> {
  if (!OK.test(file.type)) throw new Error(`${file.name}: use a JPG, PNG, GIF or WebP image`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`${file.name} couldn't be opened`)); i.src = url; });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const keep = file.type === 'image/gif' || (scale === 1 && file.size < 1_500_000);
    let blob: Blob = file;
    if (!keep) {
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const type = file.type === 'image/png' && file.size < 4_000_000 ? 'image/png' : 'image/jpeg';
      blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), type, 0.86));
    }
    if (blob.size > 5 * 1024 * 1024) throw new Error(`${file.name} is still over 5 MB after shrinking`);
    const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^,]+,/, '')); r.readAsDataURL(blob); });
    return { mediaType: (blob.type || file.type) as PickedImage['mediaType'], data, name: file.name || 'image', preview: URL.createObjectURL(blob) };
  } finally { URL.revokeObjectURL(url); }
}

export async function addImages(current: PickedImage[], files: File[] | FileList): Promise<PickedImage[]> {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
  const room = MAX_IMAGES - current.length;
  if (list.length > room) toast(`Up to ${MAX_IMAGES} images per question.`, 'bad');
  const out = [...current];
  for (const f of list.slice(0, Math.max(0, room))) {
    try { out.push(await shrink(f)); } catch (e) { toast((e as Error).message, 'bad'); }
  }
  return out;
}

/** Images from a paste event (screenshots copied to the clipboard). */
export const pastedFiles = (e: React.ClipboardEvent) => Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));

export function AttachButton({ images, onChange }: { images: PickedImage[]; onChange: (v: PickedImage[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden
        onChange={async (e) => { const f = e.target.files; if (f?.length) onChange(await addImages(images, f)); e.target.value = ''; }} />
      <button type="button" className="ghost icon" aria-label="Attach an image" title="Attach an image (or paste a screenshot)" disabled={images.length >= MAX_IMAGES} onClick={() => ref.current?.click()}>
        <ImagePlus size={15} />
      </button>
    </>
  );
}

export function ImageChips({ images, onChange }: { images: PickedImage[]; onChange: (v: PickedImage[]) => void }) {
  if (!images.length) return null;
  return (
    <div className="img-chips">
      {images.map((im, i) => (
        <span key={im.preview} className="img-chip" title={im.name}>
          <img src={im.preview} alt={im.name} />
          <button type="button" aria-label={`Remove ${im.name}`} onClick={() => { URL.revokeObjectURL(im.preview); onChange(images.filter((_, j) => j !== i)); }}><X size={11} /></button>
        </span>
      ))}
      <span className="muted small">Images go to the AI as they are.</span>
    </div>
  );
}

/** What the server needs (no previews). */
export const forUpload = (images: PickedImage[]) => images.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
