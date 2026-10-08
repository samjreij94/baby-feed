import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Crisp SVG QR (dark modules on a light tile so phone cameras read it in both themes). */
export function QrCode({ text, size = 200 }: { text: string; size?: number }) {
  const { path, n } = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
    return { path: d, n };
  }, [text]);
  const q = 2; // quiet zone (modules)
  return (
    <svg className="qr" width={size} height={size} viewBox={`${-q} ${-q} ${n + q * 2} ${n + q * 2}`} role="img" aria-label="QR code for the invite link" shapeRendering="crispEdges">
      <rect x={-q} y={-q} width={n + q * 2} height={n + q * 2} fill="var(--qr-bg)" />
      <path d={path} fill="var(--qr-fg)" />
    </svg>
  );
}
