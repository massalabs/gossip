import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

export interface ShareInvitationOptions {
  deepLinkUrl: string;
}

export interface ShareQRCodeOptions {
  qrDataUrl: string;
  fileName?: string;
}

export interface ShareFileOptions {
  blob: Blob;
  fileName: string;
  title?: string;
  mimeType?: string;
}

function isShareCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.includes('cancel') ||
      error.message.includes('User cancelled'))
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('Unexpected FileReader result type'));
        return;
      }
      const commaIndex = result.indexOf(',');
      if (commaIndex === -1 || commaIndex === result.length - 1) {
        reject(new Error('Invalid data URL format from FileReader'));
        return;
      }
      resolve(result.substring(commaIndex + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function shareFileViaNative(
  blob: Blob,
  fileName: string,
  title: string
): Promise<void> {
  const base64Data = await blobToBase64(blob);

  try {
    const { uri } = await Filesystem.writeFile({
      path: fileName,
      data: base64Data,
      directory: Directory.Cache,
    });

    await Share.share({
      title,
      files: [uri],
      dialogTitle: title,
    });
  } finally {
    try {
      await Filesystem.deleteFile({
        path: fileName,
        directory: Directory.Cache,
      });
    } catch {
      // File cleanup is best effort
    }
  }
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Returns true if we can open a native share sheet or Web Share API,
 * i.e. actually share via other apps and not just copy to clipboard.
 */
export function canShareInvitationViaOtherApp(): boolean {
  if (Capacitor.isNativePlatform()) {
    return true;
  }

  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function'
  ) {
    return true;
  }

  return false;
}

/**
 * Share a file using native share sheet on mobile devices,
 * Web Share API on web browsers, or download as fallback.
 */
export async function shareFile(options: ShareFileOptions): Promise<void> {
  const { blob, fileName, title = 'Share File', mimeType } = options;

  // Native platforms: write to cache and share via Capacitor
  if (Capacitor.isNativePlatform()) {
    try {
      await shareFileViaNative(blob, fileName, title);
      return;
    } catch (error) {
      if (isShareCancellation(error)) return;
      throw error;
    }
  }

  // Web: try Web Share API with file support
  try {
    const file = new File([blob], fileName, {
      type: mimeType ?? blob.type,
    });

    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title, files: [file] });
      return;
    }
  } catch (error) {
    if (isShareCancellation(error)) return;
    // Fall through to download
  }

  // Fallback: download
  downloadBlob(blob, fileName);
}

/**
 * Share invitation link using native share sheet on mobile devices
 * or Web Share API on web browsers.
 */
export async function shareInvitation(
  options: ShareInvitationOptions
): Promise<void> {
  const { deepLinkUrl } = options;

  if (!deepLinkUrl) {
    throw new Error('deepLinkUrl is required');
  }

  const shareText = 'Join me on Gossip!';
  const shareTitle = 'Join me on Gossip';

  // Use native Capacitor Share plugin on native platforms
  if (Capacitor.isNativePlatform()) {
    try {
      await Share.share({
        title: shareTitle,
        text: shareText,
        url: deepLinkUrl,
        dialogTitle: shareTitle,
      });
      return;
    } catch (error) {
      if (isShareCancellation(error)) return;
      throw error;
    }
  }

  // Use Web Share API on web platforms
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        url: deepLinkUrl,
      });
      return;
    } catch (error) {
      if (isShareCancellation(error)) return;
      // If Web Share API fails, fall back to clipboard
      console.warn('Web Share API failed, falling back to clipboard:', error);
    }
  }

  // Fallback: Copy to clipboard if share is not available
  try {
    await navigator.clipboard.writeText(deepLinkUrl);
  } catch (clipboardError) {
    throw new Error(
      `Failed to share invitation: ${clipboardError instanceof Error ? clipboardError.message : 'Unknown error'}`
    );
  }
}

/**
 * Share QR code image using native share sheet on mobile devices
 * or Web Share API on web browsers.
 */
export async function shareQRCode(options: ShareQRCodeOptions): Promise<void> {
  const { qrDataUrl, fileName = 'qr-code.png' } = options;

  if (!qrDataUrl) {
    throw new Error('qrDataUrl is required');
  }

  // Convert SVG data URL to PNG blob for better compatibility
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(
        blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert SVG to PNG'));
          }
        },
        'image/png',
        1.0
      );
    };
    img.onerror = () => {
      reject(new Error('Failed to load QR code image'));
    };
    img.src = qrDataUrl;
  });

  await shareFile({
    blob: pngBlob,
    fileName,
    title: 'Gossip QR Code',
    mimeType: 'image/png',
  });
}
