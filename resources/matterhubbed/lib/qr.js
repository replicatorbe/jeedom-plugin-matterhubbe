/*
 * QR code d'appairage en SVG, pour la page du plugin.
 *
 * matter.js sait encoder le QR d'un code « MT:… » mais ne le rend qu'en texte
 * pour terminal : chaque caractère porte deux modules superposés, un bloc
 * plein étant un module clair. On relit ce texte pour en faire une image,
 * plutôt que d'embarquer une bibliothèque QR de plus.
 */

import { QrCode } from "@matter/main/types";

const LIT = { "█": [true, true], "▀": [true, false], "▄": [false, true] };

export function qrSvg(pairingCode) {
    if (!pairingCode) return "";
    const lines = QrCode.encode(pairingCode).split("\n").filter(line => line.length);
    const rows = [];
    for (const line of lines) {
        const top = [];
        const bottom = [];
        for (const char of line) {
            const [t, b] = LIT[char] ?? [false, false];
            top.push(t);
            bottom.push(b);
        }
        rows.push(top, bottom);
    }
    /* La première et la dernière demi-ligne ne sont que le fond du terminal. */
    rows.shift();
    rows.pop();
    const width = Math.max(...rows.map(r => r.length));
    rows.length = Math.min(rows.length, width);

    const size = width;
    /* Les lecteurs veulent une marge blanche d'au moins quatre modules ; le texte n'en porte qu'un. */
    const margin = 3;
    let path = "";
    rows.forEach((row, y) => {
        row.forEach((lit, x) => {
            if (!lit) path += `M${x} ${y}h1v1h-1z`;
        });
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-margin} ${-margin} ${size + 2 * margin} ${rows.length + 2 * margin}" shape-rendering="crispEdges">`
        + `<rect x="${-margin}" y="${-margin}" width="${size + 2 * margin}" height="${rows.length + 2 * margin}" fill="#fff"/><path fill="#000" d="${path}"/></svg>`;
}
