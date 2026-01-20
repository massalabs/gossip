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
 * Share invitation link using native share sheet on mobile devices
 * or Web Share API on web browsers.
 *
 * @param options - Share options containing the invite URL
 * @returns Promise that resolves when sharing is complete or fails
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
      // User cancelled sharing - this is expected behavior, don't throw
      if (
        error instanceof Error &&
        (error.message.includes('cancel') ||
          error.message.includes('User cancelled'))
      ) {
        return;
      }
      // Re-throw other errors
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
      // User cancelled sharing - this is expected behavior, don't throw
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('cancel'))
      ) {
        return;
      }
      // If Web Share API fails, fall back to clipboard
      console.warn('Web Share API failed, falling back to clipboard:', error);
    }
  }

  // Fallback: Copy to clipboard if share is not available
  try {
    await navigator.clipboard.writeText(deepLinkUrl);
    // Note: We don't throw here since copying succeeded, but we could
  } catch (clipboardError) {
    throw new Error(
      `Failed to share invitation: ${clipboardError instanceof Error ? clipboardError.message : 'Unknown error'}`
    );
  }
}

/**
 * Share QR code image using native share sheet on mobile devices
 * or Web Share API on web browsers.
 *
 * @param options - Share options containing the QR code data URL
 * @returns Promise that resolves when sharing is complete or fails
 */
export async function shareQRCode(options: ShareQRCodeOptions): Promise<void> {
  const { qrDataUrl, fileName = 'qr-code.png' } = options;

  if (!qrDataUrl) {
    throw new Error('qrDataUrl is required');
  }

  // Convert SVG data URL to PNG blob for better compatibility
  const convertSvgToPng = async (svgDataUrl: string): Promise<Blob> => {
    return new Promise((resolve, reject) => {
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
      img.onerror = reject;
      img.src = svgDataUrl;
    });
  };

  // QR code is always SVG, convert to PNG for sharing
  const pngBlob = await convertSvgToPng(qrDataUrl);
  const file = new File([pngBlob], fileName, { type: 'image/png' });

  // Use native Capacitor Share plugin on native platforms
  if (Capacitor.isNativePlatform()) {
    let tempFilePath: string | null = null;
    try {
      // Convert PNG blob to base64 for Filesystem
      const pngDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result as string);
        };
        reader.onerror = reject;
        reader.readAsDataURL(pngBlob);
      });

      // Extract base64 part (remove data URL prefix)
      const base64Data = pngDataUrl.split(',')[1];

      // Write file to cache directory
      await Filesystem.writeFile({
        path: fileName,
        data: base64Data,
        directory: Directory.Cache,
      });

      // Get the file URI for sharing
      const fileUri = await Filesystem.getUri({
        path: fileName,
        directory: Directory.Cache,
      });

      tempFilePath = fileUri.uri;

      // Share the file using the file URI
      await Share.share({
        title: 'Gossip QR Code',
        text: 'Join me on Gossip',
        url: fileUri.uri,
        dialogTitle: 'Share QR Code',
      });

      // Clean up: delete the temporary file
      try {
        await Filesystem.deleteFile({
          path: fileName,
          directory: Directory.Cache,
        });
      } catch (cleanupError) {
        // Log but don't throw - file cleanup is best effort
        console.warn('Failed to cleanup temporary QR code file:', cleanupError);
      }

      return;
    } catch (error) {
      // Clean up temp file if it was created
      if (tempFilePath) {
        try {
          await Filesystem.deleteFile({
            path: fileName,
            directory: Directory.Cache,
          });
        } catch (cleanupError) {
          console.warn(
            'Failed to cleanup temporary QR code file:',
            cleanupError
          );
        }
      }

      // User cancelled sharing - this is expected behavior, don't throw
      if (
        error instanceof Error &&
        (error.message.includes('cancel') ||
          error.message.includes('User cancelled'))
      ) {
        return;
      }
      // Re-throw other errors
      throw error;
    }
  }

  // Use Web Share API on web platforms with file support
  if (
    typeof navigator !== 'undefined' &&
    navigator.share &&
    navigator.canShare &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({
        title: 'Gossip QR Code',
        text: 'Join me on Gossip',
        files: [file],
      });
      return;
    } catch (error) {
      // User cancelled sharing - this is expected behavior, don't throw
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('cancel'))
      ) {
        return;
      }
      // If Web Share API fails, fall back to downloading the image
      console.warn('Web Share API failed, falling back to download:', error);
    }
  }

  // Fallback: Download the image
  try {
    const url = URL.createObjectURL(pngBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (downloadError) {
    throw new Error(
      `Failed to share QR code: ${downloadError instanceof Error ? downloadError.message : 'Unknown error'}`
    );
  }
}
