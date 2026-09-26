/*
 * Conversions de couleur entre Jeedom et Matter.
 *
 * Jeedom : « #rrggbb » (LIGHT_COLOR / LIGHT_SET_COLOR), la luminosité étant
 * une commande à part. Matter : teinte et saturation sur 0..254, ou
 * coordonnées CIE xy sur 0..65279 (valeur × 65536), la luminosité étant dans
 * LevelControl. Une couleur envoyée à Jeedom a donc toujours une luminosité
 * maximale (V = 100 %) : sinon couleur et luminosité se multiplieraient.
 */

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function parseHex(text) {
    const match = /^#?([0-9a-f]{6})/i.exec(String(text ?? "").trim());
    if (!match) return null;
    const n = Number.parseInt(match[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function toHex({ r, g, b }) {
    const part = v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
    return `#${part(r)}${part(g)}${part(b)}`;
}

/* Teinte Matter 0..254 et saturation 0..254 → RGB à pleine luminosité. */
export function hsToRgb(hue, saturation) {
    const h = ((hue / 254) * 360) % 360;
    const s = clamp(saturation / 254, 0, 1);
    const c = s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = 1 - c;
    const [r, g, b] =
        h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/* RGB → teinte et saturation Matter (0..254). La luminosité est ignorée. */
export function rgbToHs({ r, g, b }) {
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    const max = Math.max(rr, gg, bb);
    const min = Math.min(rr, gg, bb);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === rr) h = 60 * (((gg - bb) / d) % 6);
        else if (max === gg) h = 60 * ((bb - rr) / d + 2);
        else h = 60 * ((rr - gg) / d + 4);
    }
    if (h < 0) h += 360;
    const s = max === 0 ? 0 : d / max;
    return { hue: clamp(Math.round((h / 360) * 254), 0, 254), saturation: clamp(Math.round(s * 254), 0, 254) };
}

const linear = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gamma = v => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/* RGB → CIE xy Matter (0..65279). Blanc D65 pour du noir. */
export function rgbToXy({ r, g, b }) {
    const R = linear(r / 255);
    const G = linear(g / 255);
    const B = linear(b / 255);
    const X = R * 0.4124 + G * 0.3576 + B * 0.1805;
    const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const Z = R * 0.0193 + G * 0.1192 + B * 0.9505;
    const sum = X + Y + Z;
    const x = sum === 0 ? 0.3127 : X / sum;
    const y = sum === 0 ? 0.329 : Y / sum;
    return { x: clamp(Math.round(x * 65536), 0, 65279), y: clamp(Math.round(y * 65536), 0, 65279) };
}

/* CIE xy Matter → RGB à pleine luminosité (la composante la plus forte à 255). */
export function xyToRgb(xm, ym) {
    const x = xm / 65536;
    const y = Math.max(ym / 65536, 0.0001);
    const Y = 1;
    const X = (x / y) * Y;
    const Z = ((1 - x - y) / y) * Y;
    let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
    let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
    let b = X * 0.0557 - Y * 0.204 + Z * 1.057;
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);
    const max = Math.max(r, g, b, 1e-9);
    return { r: gamma(r / max) * 255, g: gamma(g / max) * 255, b: gamma(b / max) * 255 };
}

export function kelvinToMireds(kelvin) {
    return kelvin > 0 ? Math.round(1_000_000 / kelvin) : null;
}

export function miredsToKelvin(mireds) {
    return mireds > 0 ? Math.round(1_000_000 / mireds) : null;
}
