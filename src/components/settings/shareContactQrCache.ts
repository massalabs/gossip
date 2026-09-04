import QRCodeStyling from 'qr-code-styling';

/** Module-level cache so QR survives unmount/remount (slide transitions)
 *  and can be pre-warmed from other pages (e.g. Discussions on mount). */
export const qrCache = new Map<string, string>();

const QR_CACHE_MAX_ENTRIES = 20;

/** Insert into the cache, evicting the oldest entry when the cap is hit
 *  (Map preserves insertion order) so the cache stays bounded. */
export const setCachedQr = (deepLinkUrl: string, dataUrl: string): void => {
  if (!qrCache.has(deepLinkUrl) && qrCache.size >= QR_CACHE_MAX_ENTRIES) {
    const oldestKey = qrCache.keys().next().value;
    if (oldestKey !== undefined) qrCache.delete(oldestKey);
  }
  qrCache.set(deepLinkUrl, dataUrl);
};

export const generateQRDataUrl = async (
  deepLinkUrl: string
): Promise<string> => {
  const foregroundColor = '#1a1a1d';
  const backgroundColor = '#ffffff';

  const qrCodeStyling = new QRCodeStyling({
    width: 280,
    height: 280,
    data: deepLinkUrl,
    image: '/favicon/favicon.svg',
    dotsOptions: { type: 'extra-rounded', color: foregroundColor },
    cornersSquareOptions: { type: 'extra-rounded', color: foregroundColor },
    cornersDotOptions: { type: 'dot', color: foregroundColor },
    backgroundOptions: { color: backgroundColor, round: 0 },
    imageOptions: {
      margin: 10,
      imageSize: 0.25,
      crossOrigin: 'anonymous',
    },
  });

  const svg = await qrCodeStyling.getRawData('svg');
  if (!svg) throw new Error('Failed to generate QR SVG');

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(svg as Blob);
  });
};

/** Generate and cache the QR image for `deepLinkUrl`. Safe to call in the
 *  background — subsequent mounts of ShareContactQR will hit the cache. */
export const prewarmShareQR = async (deepLinkUrl: string): Promise<void> => {
  if (qrCache.has(deepLinkUrl)) return;
  try {
    const dataUrl = await generateQRDataUrl(deepLinkUrl);
    setCachedQr(deepLinkUrl, dataUrl);
  } catch {
    // Best-effort; on-demand generation will retry when the page opens.
  }
};
