#!/usr/bin/env node
/*
 * Démon du plugin Jeedom matterhubbe : expose des équipements Jeedom comme un
 * pont Matter local, pilotable par Google Home sans passer par le cloud.
 *
 *   Jeedom ──exec()──► matterhubbed.js ──Matter (UDP 5540, mDNS)──► Google Home
 *     ▲                   │
 *     │                   ├── GET  action=config   configuration + valeurs
 *     │                   ├── GET  action=changes  attente longue sur event::changes
 *     │                   ├── POST action=exec     commande demandée par Google
 *     │                   └── POST action=status   codes d'appairage, contrôleurs
 *     └── socket TCP 127.0.0.1:<socketport> : reload, status, openCommissioning, factoryReset
 *
 * La clé API du plugin arrive sur l'entrée standard, jamais sur la ligne de
 * commande (ps est lisible par tous).
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { parseArgs } from "node:util";
import { Environment, Logger } from "@matter/main";
/* Avant bridge.js, impérativement : voir lib/patch-level-control.js. */
import { checkLevelControlPatch } from "./lib/patch-level-control.js";
import { Bridge } from "./lib/bridge.js";
import { JeedomLevelControlServer } from "./lib/devices.js";
import { JeedomLink } from "./lib/jeedom.js";
import { isDebug, log, setLevel } from "./lib/log.js";

const { values: args } = parseArgs({
    options: {
        callback: { type: "string" },
        socketport: { type: "string", default: "55064" },
        loglevel: { type: "string", default: "info" },
        pid: { type: "string" },
        datadir: { type: "string" },
        "mdns-interface": { type: "string", default: "" },
    },
    strict: false,
});

setLevel(args.loglevel);

if (!args.callback || !args.datadir) {
    log.error("Paramètres --callback et --datadir obligatoires");
    process.exit(1);
}

const apikey = readFileSync(0, "utf8").split("\n")[0].trim();
if (!apikey) {
    log.error("Clé API absente de l'entrée standard");
    process.exit(1);
}

/* ------------------------------------------------------------ matter.js */

mkdirSync(args.datadir, { recursive: true });
const env = Environment.default;
/* Sans ces deux chemins, matter.js écrit dans ~/.matter, c'est-à-dire /var/www/.matter. */
env.vars.set("path.root", args.datadir);
env.vars.set("storage.path", args.datadir);
/* Les signaux et le code de sortie sont gérés ici, pas par matter.js. */
env.vars.set("runtime.signals", false);
env.vars.set("runtime.exitcode", false);
if (args["mdns-interface"]) {
    env.vars.set("mdns.networkInterface", args["mdns-interface"]);
}
Logger.format = "plain";
Logger.level = isDebug() ? "info" : "warn";

checkLevelControlPatch(JeedomLevelControlServer);

/* ------------------------------------------------------------ état */

const link = new JeedomLink(args.callback, apikey);
const bridges = new Map();
/* Ponts qui n'ont pas démarré (port pris…) : id → message, signalé à Jeedom et retenté. */
const failures = new Map();
/*
 * Dernière valeur connue de chaque info suivie. Les événements reçus pendant
 * qu'un pont démarre ne trouvent pas encore leur appareil : on les garde ici
 * et on les réapplique une fois le pont prêt.
 */
const lastValues = new Map();
let cursor = null;
let stopping = false;

function knownValues() {
    return Object.fromEntries(lastValues);
}

/* Les rechargements passent un à un : deux reconstructions croisées abîmeraient les ponts. */
let chain = Promise.resolve();
function serialized(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
}

/* Les changements d'état d'un pont partent vers Jeedom groupés, une seconde plus tard. */
let statusTimer = null;
function scheduleStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
        statusTimer = null;
        link.sendStatus({ bridges: statuses() });
    }, 1000);
}

function statuses() {
    const out = [...bridges.values()].map(b => b.status());
    for (const [id, error] of failures) out.push({ id, running: false, error });
    return out;
}

async function fetchConfig() {
    for (let attempt = 1; !stopping; attempt++) {
        try {
            return await link.getConfig();
        } catch (error) {
            log.warning(`Configuration illisible (essai ${attempt}) :`, error);
            await new Promise(resolve => setTimeout(resolve, Math.min(30, attempt * 5) * 1000));
        }
    }
}

async function applyConfig(config) {
    for (const [cmdId, value] of Object.entries(config.values ?? {})) {
        lastValues.set(String(cmdId), value);
    }
    const values = knownValues();
    const wanted = new Map((config.bridges ?? []).map(b => [b.id, b]));

    for (const [id, bridge] of bridges) {
        const next = wanted.get(id);
        if (next && !bridge.needsRestart(next)) continue;
        await bridge.stop();
        bridges.delete(id);
        log.info(`${bridge.label} arrêté`);
    }

    for (const [id, bridgeConfig] of wanted) {
        const existing = bridges.get(id);
        if (existing) {
            await existing.sync(bridgeConfig, values);
            continue;
        }
        const bridge = new Bridge(bridgeConfig, link, scheduleStatus);
        try {
            await bridge.start(values);
            bridges.set(id, bridge);
            failures.delete(id);
        } catch (error) {
            log.error(`${bridge.label} ne démarre pas :`, error);
            failures.set(id, error?.message ?? String(error));
            await bridge.stop();
        }
    }
    for (const id of failures.keys()) {
        if (!wanted.has(id)) failures.delete(id);
    }
    /* Ce qui a changé pendant le démarrage est rattrapé ici. */
    const latest = knownValues();
    for (const bridge of bridges.values()) bridge.applyValues(latest);
    scheduleStatus();
}

/* Un pont qui n'a pas démarré (port encore pris après un redémarrage…) est retenté chaque minute. */
setInterval(() => {
    if (failures.size && !stopping) reload().catch(error => log.error("Nouvel essai des ponts :", error));
}, 60_000).unref();

function reload() {
    return serialized(async () => {
        const config = await fetchConfig();
        if (config) await applyConfig(config);
    });
}

/* ------------------------------------------------------------ valeurs Jeedom */

async function pollChanges() {
    let failuresInRow = 0;
    while (!stopping) {
        try {
            const answer = await link.getChanges(cursor, 25);
            if (!answer || !Array.isArray(answer.events)) {
                throw new Error(`réponse inattendue : ${JSON.stringify(answer).slice(0, 200)}`);
            }
            if (answer.datetime) cursor = answer.datetime;
            for (const event of answer.events) {
                lastValues.set(String(event.cmd_id), event.value);
                for (const bridge of bridges.values()) {
                    bridge.applyValue(event.cmd_id, event.value);
                }
            }
            failuresInRow = 0;
        } catch (error) {
            if (stopping) return;
            /* 5 s, puis de plus en plus espacé jusqu'à une minute : un Jeedom arrêté ne doit pas remplir le journal. */
            failuresInRow++;
            const delay = Math.min(60, 5 * failuresInRow);
            if (failuresInRow <= 3 || failuresInRow % 10 === 0) {
                log.warning(`Suivi des valeurs Jeedom interrompu (${failuresInRow}), reprise dans ${delay} s :`, error);
            }
            await new Promise(resolve => setTimeout(resolve, delay * 1000));
        }
    }
}

/* ------------------------------------------------------------ ordres de Jeedom */

async function handleOrder(message) {
    if (message.apikey !== apikey) {
        return { error: "clé API refusée" };
    }
    const bridge = bridges.get(Number(message.bridge_id));
    switch (message.order) {
        case "reload":
            reload().catch(error => log.error("Rechargement :", error));
            return { result: "ok" };
        case "status":
            return { result: statuses() };
        case "openCommissioning":
            if (!bridge) return { error: "pont inconnu ou arrêté" };
            return { result: "ok", message: await bridge.openCommissioning() };
        case "factoryReset":
            if (!bridge) return { error: "pont inconnu ou arrêté" };
            /* Hors de la file des rechargements : elle peut attendre un Jeedom injoignable. */
            await bridge.factoryReset(knownValues());
            return { result: "ok" };
        default:
            return { error: `ordre inconnu : ${message.order}` };
    }
}

const socket = createServer(connection => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 65536) {
            connection.destroy();
            return;
        }
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                connection.write(JSON.stringify({ error: "JSON illisible" }) + "\n");
                continue;
            }
            log.debug("Ordre reçu :", message.order);
            handleOrder(message)
                .catch(error => ({ error: error.message }))
                .then(answer => {
                    if (!connection.destroyed) connection.write(JSON.stringify(answer) + "\n");
                });
        }
    });
    connection.on("error", () => {});
});

/* ------------------------------------------------------------ cycle de vie */

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log.info(`Arrêt du démon (${signal})`);
    socket.close();
    for (const bridge of bridges.values()) {
        await bridge.stop();
    }
    /* Seulement s'il est le nôtre : un second démon lancé par erreur ne doit pas effacer celui du premier. */
    if (args.pid) {
        try {
            if (readFileSync(args.pid, "utf8").trim() === String(process.pid)) unlinkSync(args.pid);
        } catch {
            /* déjà supprimé par Jeedom */
        }
    }
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", error => log.error("Erreur non rattrapée :", error));

socket.on("error", error => {
    log.error(`Port des ordres ${args.socketport} indisponible (un autre démon tourne-t-il déjà ?) :`, error);
    shutdown("port occupé");
});
/*
 * Le fichier de PID n'est écrit qu'une fois le port obtenu : deux lancements
 * rapprochés (fin d'installation des dépendances et contrôle du cœur) ne
 * doivent pas faire croire à Jeedom que le second, voué à s'arrêter, est le bon.
 */
await new Promise(resolve => {
    socket.listen(Number(args.socketport), "127.0.0.1", () => {
        if (args.pid) writeFileSync(args.pid, String(process.pid));
        log.info(`Démon démarré (pid ${process.pid}), ordres sur 127.0.0.1:${args.socketport}`);
        resolve();
    });
});

/* Démarrage dans la file : un « reload » reçu pendant ce temps passera après, jamais avant. */
await serialized(async () => {
    const config = await fetchConfig();
    if (!config) return;
    cursor = config.datetime ?? null;
    await applyConfig(config);
});
pollChanges();
