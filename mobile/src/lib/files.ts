/**
 * Files on the phone: picking them (camera, Photos, Files) with the desktop's
 * limits, moving their bytes over HTTP (the transport's `HttpAdapter`), and
 * opening what the agent sent: images in the app's own viewer, everything
 * else in Quick Look.
 *
 * Downloads are cached by what they are (a blob id, or an agent and the
 * attachment's path), never by URL: an attachment never changes once sent,
 * and the same file comes back over a different route just the same.
 */

import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '@shipstudio/companion-protocol';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import type { HttpAdapter } from './transport';

/** A file chosen on the phone, before it is uploaded. */
export interface PickedFile {
  uri: string;
  name: string;
  mime: string;
  /** Bytes, when the picker says; the Mac checks again either way. */
  size?: number;
  width?: number;
  height?: number;
}

const MB = 1024 * 1024;
const CACHE = `${FileSystem.cacheDirectory ?? ''}companion/`;

/** The desktop's wording (agents/attachments.rs), so both say the same thing. */
export const tooBig = (name: string, size: number) =>
  `${name} is ${Math.ceil(size / MB)} MB. Files can be up to ${MAX_ATTACHMENT_BYTES / MB} MB.`;
export const tooMany = () => `You can attach up to ${MAX_ATTACHMENTS} files at a time.`;

/**
 * Keep what fits: the first `room` files under the size limit. Returns the
 * kept files and one sentence about what was left out, if anything was.
 */
export function admit(
  files: PickedFile[],
  room: number
): { kept: PickedFile[]; refused: string | null } {
  const big = files.find((f) => f.size != null && f.size > MAX_ATTACHMENT_BYTES);
  const fitting = files.filter((f) => f.size == null || f.size <= MAX_ATTACHMENT_BYTES);
  const kept = fitting.slice(0, Math.max(0, room));
  const refused = big
    ? tooBig(big.name, big.size!)
    : fitting.length > kept.length
      ? tooMany()
      : null;
  return { kept, refused };
}

export const isImage = (mime: string) => mime.startsWith('image/');
/** Images the Mac can thumbnail and the phone can draw. */
export const isPreviewableImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|heic)$/.test(mime);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** "Report.PDF" → "PDF": the badge on a file chip. */
export const extensionOf = (name: string) =>
  name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE';

// ---- Picking ------------------------------------------------------------------

function fromAsset(a: ImagePicker.ImagePickerAsset): PickedFile {
  const fallback = a.type === 'video' ? 'video.mov' : 'photo.jpg';
  return {
    uri: a.uri,
    name: a.fileName ?? a.uri.split('/').pop() ?? fallback,
    mime: a.mimeType ?? (a.type === 'video' ? 'video/quicktime' : 'image/jpeg'),
    size: a.fileSize,
    width: a.width,
    height: a.height,
  };
}

/** Throws a sentence when the user said no to the permission. */
export async function takePhoto(): Promise<PickedFile[]> {
  const { granted } = await ImagePicker.requestCameraPermissionsAsync();
  if (!granted) throw new Error('Ship Studio can’t use the camera. Allow it in Settings.');
  const r = await ImagePicker.launchCameraAsync({ quality: 0.85 });
  return r.canceled ? [] : r.assets.map(fromAsset);
}

export async function pickPhotos(limit: number): Promise<PickedFile[]> {
  const r = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    quality: 0.9,
  });
  return r.canceled ? [] : r.assets.map(fromAsset);
}

export async function pickDocuments(): Promise<PickedFile[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (r.canceled) return [];
  return r.assets.map((a) => ({
    uri: a.uri,
    name: a.name,
    mime: a.mimeType ?? 'application/octet-stream',
    size: a.size,
  }));
}

// ---- Bytes ----------------------------------------------------------------------

async function cachePath(key: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, key);
  const name = key.split('/').pop() ?? 'file';
  return `${CACHE}${digest.slice(0, 24)}-${name.replace(/[^\w.-]/g, '_')}`;
}

export const http: HttpAdapter = {
  async upload(url, uri, headers, onProgress) {
    const task = FileSystem.createUploadTask(
      url,
      uri,
      { httpMethod: 'PUT', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers },
      ({ totalBytesSent, totalBytesExpectedToSend }) =>
        onProgress?.(totalBytesExpectedToSend ? totalBytesSent / totalBytesExpectedToSend : 0)
    );
    const res = await task.uploadAsync();
    if (!res) throw new Error('Upload cancelled');
    return { status: res.status, body: res.body };
  },
  async download(url, headers, key) {
    const dest = await cachePath(key);
    const info = await FileSystem.getInfoAsync(dest);
    if (info.exists && info.size) return { status: 200, uri: dest };
    await FileSystem.makeDirectoryAsync(CACHE, { intermediates: true }).catch(() => {});
    const res = await FileSystem.downloadAsync(url, dest, { headers });
    if (res.status !== 200) await FileSystem.deleteAsync(dest, { idempotent: true });
    return { status: res.status, uri: res.uri };
  },
};

/** Everything downloaded from this Mac. Forgetting the Mac wipes it. */
export const clearCache = () => FileSystem.deleteAsync(CACHE, { idempotent: true });

// ---- Opening ------------------------------------------------------------------------

/** Quick Look on iOS (the system's own viewer); the share sheet where that isn't available. */
export async function preview(uri: string, mime: string): Promise<void> {
  try {
    await new File(uri).preview();
  } catch {
    await share(uri, mime);
  }
}

export async function share(uri: string, mime: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn’t available here.');
  await Sharing.shareAsync(uri, { mimeType: mime });
}
