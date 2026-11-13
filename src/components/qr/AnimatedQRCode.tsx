import React, { useEffect, useMemo, useRef } from 'react';
import qrcode from 'qrcode-generator';

/**
 * Time each frame of an animated code stays on screen. Phone cameras deliver
 * 30 frames a second and ZXing (Android) decodes a 1080p frame in 30–80 ms,
 * so 150 ms gives every QR frame two or more decode attempts while a full
 * loop of a contact code (32 frames) still takes under 5 seconds.
 */
export const FRAME_INTERVAL_MS = 150;

/** Modules of white around the code; 2 is enough on a lit screen. */
const QUIET_ZONE = 2;

interface AnimatedQRCodeProps {
  /** QR alphanumeric texts, shown in a loop (one alone is shown still). */
  frames: string[];
  /** CSS pixels. */
  size?: number;
  ariaLabel: string;
  /** Alphanumeric (the default) packs uppercase texts; Byte takes any text. */
  mode?: 'Alphanumeric' | 'Byte';
}

type Matrix = boolean[][];

function toMatrix(text: string, mode: 'Alphanumeric' | 'Byte'): Matrix {
  // Error correction L: a screen is flat and clean, and lower correction
  // keeps the modules large enough for a camera at arm's length.
  const qr = qrcode(0, 'L');
  qr.addData(text, mode);
  qr.make();
  const count = qr.getModuleCount();
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col))
  );
}

/** Draws the frames of an animated QR code on a canvas, one after another. */
const AnimatedQRCode: React.FC<AnimatedQRCodeProps> = ({
  frames,
  size = 280,
  ariaLabel,
  mode = 'Alphanumeric',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const matrices = useMemo(
    () => frames.map(frame => toMatrix(frame, mode)),
    [frames, mode]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || matrices.length === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);

    let index = 0;
    const draw = () => {
      const matrix = matrices[index];
      const cells = matrix.length + QUIET_ZONE * 2;
      // Whole device pixels per module keep the edges sharp.
      const cell = Math.max(1, Math.floor(canvas.width / cells));
      const offset = Math.floor((canvas.width - cell * cells) / 2);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      for (let row = 0; row < matrix.length; row++) {
        for (let col = 0; col < matrix.length; col++) {
          if (!matrix[row][col]) continue;
          context.fillRect(
            offset + (col + QUIET_ZONE) * cell,
            offset + (row + QUIET_ZONE) * cell,
            cell,
            cell
          );
        }
      }
      index = (index + 1) % matrices.length;
    };

    draw();
    if (matrices.length === 1) return;
    const timer = setInterval(draw, FRAME_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [matrices, size]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel}
      className="rounded-2xl bg-white"
      style={{ width: size, height: size }}
    />
  );
};

export default AnimatedQRCode;
