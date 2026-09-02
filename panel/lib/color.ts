/**
 * Colour maths for the palette validator. Pure functions, no I/O.
 *
 * CIEDE2000 rather than CIE76: the ramp decisions in globals.css turn on
 * differences of one or two ΔE units, which is exactly where CIE76 is
 * unreliable. CVD simulation uses the Machado, Oliveira & Fernandes (2009)
 * matrices at severity 1.0, applied in linear RGB as that paper specifies.
 */
export type Rgb = [number, number, number];
export type Lab = [number, number, number];
export type CvdKind = "protan" | "deutan" | "tritan";

const RAD = Math.PI / 180;

export function hexToRgb(hex: string): Rgb {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}

function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function relLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function labOf(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  // sRGB -> XYZ (D65), then XYZ -> CIELAB against the D65 white point.
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b: number, a: number) => {
    if (b === 0 && a === 0) return 0;
    const d = Math.atan2(b, a) / RAD;
    return d < 0 ? d + 360 : d;
  };
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);

  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

  const Lbarp = (L1 + L2) / 2, Cbarp = (C1p + C2p) / 2;
  let hbarp: number;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
  else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * RAD)
    + 0.24 * Math.cos(2 * hbarp * RAD)
    + 0.32 * Math.cos((3 * hbarp + 6) * RAD)
    - 0.20 * Math.cos((4 * hbarp - 63) * RAD);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;

  const dl = dLp / Sl, dc = dCp / Sc, dh = dHp / Sh;
  return Math.sqrt(dl * dl + dc * dc + dh * dh + Rt * dc * dh);
}

/** Machado, Oliveira & Fernandes (2009), severity 1.0, row-major, linear RGB. */
const CVD_MATRIX: Record<CvdKind, number[]> = {
  protan: [0.152286, 1.052583, -0.204868,
           0.114503, 0.786281, 0.099216,
          -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968,
           0.280085, 0.672501, 0.047413,
          -0.011820, 0.042940, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779,
          -0.078411, 0.930809, 0.147602,
           0.004733, 0.691367, 0.303900],
};

export function simulateCvd(hex: string, kind: CvdKind): string {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const m = CVD_MATRIX[kind];
  const out: Rgb = [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
  return rgbToHex(out.map(toSrgb) as Rgb);
}
