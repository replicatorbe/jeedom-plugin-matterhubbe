/*
 * Journal du démon, au format des démons Jeedom : Jeedom redirige la sortie
 * standard vers log/matterhubbed et n'y ajoute rien.
 */

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, none: 100 };

let threshold = LEVELS.info;

export function setLevel(name) {
    threshold = LEVELS[String(name).toLowerCase()] ?? LEVELS.info;
}

export function isDebug() {
    return threshold <= LEVELS.debug;
}

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function write(level, label, args) {
    if (LEVELS[level] < threshold) {
        return;
    }
    const text = args
        .map(a => (a instanceof Error ? (isDebug() ? a.stack : a.message) : typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
    process.stdout.write(`[${stamp()}][${label}] : ${text}\n`);
}

export const log = {
    debug: (...a) => write("debug", "DEBUG", a),
    info: (...a) => write("info", "INFO", a),
    warning: (...a) => write("warning", "WARNING", a),
    error: (...a) => write("error", "ERROR", a),
};
