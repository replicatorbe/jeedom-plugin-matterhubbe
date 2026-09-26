/*
 * Appareils Matter exposés par le pont.
 *
 * Le PHP décide quels équipements Jeedom deviennent quel type d'appareil et
 * transmet, pour chacun, les identifiants des commandes qui jouent chaque rôle
 * (state, on, off, level, setLevel, value). Ce fichier ne connaît que Matter :
 * il convertit les valeurs Jeedom en attributs Matter, et les commandes Matter
 * en exécutions de commandes Jeedom.
 *
 * Deux sens, deux chemins qui ne se croisent jamais :
 *   - Jeedom → Matter : endpoint.set(), qui écrit l'attribut sans passer par
 *     les commandes du cluster, donc sans rien renvoyer à Jeedom ;
 *   - Matter → Jeedom : les commandes du cluster (on, off, toggle, niveau),
 *     surchargées ci-dessous, qui mettent l'attribut à jour tout de suite
 *     (réponse immédiate dans Google Home) et font exécuter la commande Jeedom.
 */

import { createHash } from "node:crypto";
import { Endpoint } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { LevelControlServer } from "@matter/main/behaviors/level-control";
import { OccupancySensingServer } from "@matter/main/behaviors/occupancy-sensing";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { OccupancySensing } from "@matter/main/clusters/occupancy-sensing";
import { ContactSensorDevice } from "@matter/main/devices/contact-sensor";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { HumiditySensorDevice } from "@matter/main/devices/humidity-sensor";
import { OccupancySensorDevice } from "@matter/main/devices/occupancy-sensor";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { TemperatureSensorDevice } from "@matter/main/devices/temperature-sensor";
import { log } from "./log.js";

/*
 * Appareils actifs, par endpoint : les behaviors y retrouvent leur appareil.
 * Indexé par l'objet et non par l'identifiant texte, qu'un même équipement
 * exposé sur deux ponts partagerait.
 */
const registry = new WeakMap();

function deviceOf(behavior) {
    return registry.get(behavior.endpoint);
}

/*
 * Google, pour « éteins la pièce », envoie off puis, une dizaine de
 * millisecondes plus tard, moveToLevelWithOnOff avec la dernière luminosité.
 * Transmis tel quel, ce second ordre rallume tout (home-assistant-matter-hub
 * #434). Un réglage « avec allumage » qui suit un off de moins d'une seconde
 * n'est donc que mémorisé.
 */
const OFF_SUPPRESSION_MS = 1000;

class JeedomOnOffServer extends OnOffServer.with("Lighting") {
    on() {
        const result = super.on();
        deviceOf(this)?.commandOnOff(true);
        return result;
    }

    off() {
        const result = super.off();
        deviceOf(this)?.commandOnOff(false);
        return result;
    }
    /* toggle() appelle on() ou off() : rien à ajouter. */
}

export class JeedomLevelControlServer extends LevelControlServer.with("OnOff", "Lighting") {
    /*
     * Point de passage de toutes les commandes de niveau (moveToLevel, move,
     * step et leurs variantes « WithOnOff »). La transition est rendue
     * immédiate : c'est l'équipement qui fait, ou non, son propre fondu.
     */
    transition(targetLevel, _changePerS, withOnOff = false, options = {}) {
        const min = this.minLevel;
        const max = this.maxLevel;
        const target = Math.round(Math.min(max, Math.max(min, targetLevel)));
        const device = deviceOf(this);
        const wasOn = this.agent.has(OnOffServer) ? this.agent.get(OnOffServer).state.onOff : true;

        if (withOnOff && device?.recentlyTurnedOff() && target > min) {
            this.state.currentLevel = target;
            return;
        }
        const result = super.transition(target, 0, withOnOff, options);
        device?.commandLevel(target, withOnOff, wasOn);
        return result;
    }
}

const BridgedInfo = BridgedDeviceBasicInformationServer;

const PresenceSensing = OccupancySensingServer.with(OccupancySensing.Feature.PhysicalContact);

/* ------------------------------------------------------------ conversions */

function toBool(value) {
    if (typeof value === "boolean") return value;
    const text = String(value ?? "").trim().toLowerCase();
    if (text === "on" || text === "true") return true;
    const number = Number(text);
    return Number.isFinite(number) && number > 0;
}

function toNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(String(value).replace(",", "."));
    return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/* Matter limite les chaînes de BridgedDeviceBasicInformation à 32 octets. */
function matterString(text, max = 32) {
    let out = String(text ?? "").replace(/[\u0000-\u001f]/g, " ").trim();
    while (Buffer.byteLength(out, "utf8") > max) {
        out = out.slice(0, -1);
    }
    return out || "Jeedom";
}

/* ------------------------------------------------------------ types */

/*
 * Pour chaque type : le type d'endpoint Matter, et la traduction d'une valeur
 * Jeedom (rôle → valeur) en état Matter partiel.
 */
const KINDS = {
    onoff_light: {
        type: () => OnOffLightDevice.with(BridgedInfo, JeedomOnOffServer),
        state(role, value, device) {
            if (role === "state") return { onOff: { onOff: toBool(value) } };
            /* Lampe variable exposée en tout ou rien, sans info d'état : c'est la luminosité qui le dit. */
            if (role === "level" && !device.spec.cmds.state) {
                const number = toNumber(value);
                return { onOff: { onOff: number !== null && number > device.levelMin } };
            }
            return null;
        },
    },

    plug: {
        type: () => OnOffPlugInUnitDevice.with(BridgedInfo, JeedomOnOffServer),
        state(role, value) {
            if (role === "state") return { onOff: { onOff: toBool(value) } };
            return null;
        },
    },

    dimmable_light: {
        type: () => DimmableLightDevice.with(BridgedInfo, JeedomOnOffServer, JeedomLevelControlServer),
        /* Lampe éteinte au démarrage : sans niveau, Google n'affiche pas de luminosité et « step » échoue. */
        initial: { levelControl: { currentLevel: 254 } },
        state(role, value, device) {
            const out = {};
            if (role === "state") {
                out.onOff = { onOff: toBool(value) };
            }
            if (role === "level") {
                const level = device.levelToMatter(value);
                if (level !== null) {
                    out.levelControl = { currentLevel: level };
                }
                /* Sans info d'état dédiée, c'est la luminosité qui dit si la lampe est allumée. */
                if (!device.spec.cmds.state) {
                    const number = toNumber(value);
                    out.onOff = { onOff: number !== null && number > device.levelMin };
                }
            }
            return Object.keys(out).length ? out : null;
        },
    },

    contact: {
        type: () => ContactSensorDevice.with(BridgedInfo),
        /* Jeedom : 1 = fermé (widget « porte » du cœur). Matter : true = contact, donc fermé. */
        state(role, value, device) {
            if (role !== "value") return null;
            return { booleanState: { stateValue: toBool(value) !== !!device.spec.params.invert } };
        },
    },

    temperature: {
        type: () => TemperatureSensorDevice.with(BridgedInfo),
        state(role, value) {
            if (role !== "value") return null;
            const number = toNumber(value);
            if (number === null) return null;
            return { temperatureMeasurement: { measuredValue: clamp(Math.round(number * 100), -27315, 32767) } };
        },
    },

    humidity: {
        type: () => HumiditySensorDevice.with(BridgedInfo),
        state(role, value) {
            if (role !== "value") return null;
            const number = toNumber(value);
            if (number === null) return null;
            return { relativeHumidityMeasurement: { measuredValue: clamp(Math.round(number * 100), 0, 10000) } };
        },
    },

    occupancy: {
        type: () => OccupancySensorDevice.with(BridgedInfo, PresenceSensing),
        initial: {
            occupancySensing: {
                occupancySensorType: OccupancySensing.OccupancySensorType.PhysicalContact,
                occupancySensorTypeBitmap: { pir: false, ultrasonic: false, physicalContact: true },
            },
        },
        state(role, value, device) {
            if (role !== "value") return null;
            return { occupancySensing: { occupancy: { occupied: toBool(value) !== !!device.spec.params.invert } } };
        },
    },
};

export function isSupportedKind(kind) {
    return Object.hasOwn(KINDS, kind);
}

/* Fusion superficielle par cluster : deux rôles peuvent toucher le même cluster. */
function mergeState(target, patch) {
    for (const [cluster, values] of Object.entries(patch)) {
        target[cluster] = { ...(target[cluster] ?? {}), ...values };
    }
    return target;
}

/* ------------------------------------------------------------ appareil */

export class Device {
    #link;
    #queue = Promise.resolve();
    #lastOff = 0;
    #lastOnLevel = 254;
    #values = new Map();

    constructor(spec, link) {
        this.spec = spec;
        this.kind = KINDS[spec.kind];
        this.#link = link;
        this.endpoint = null;
        /* Rôles joués par chaque commande Jeedom : une même info peut être état et niveau. */
        this.roles = new Map();
        for (const [role, cmdId] of Object.entries(spec.cmds ?? {})) {
            if (cmdId === null || cmdId === undefined || cmdId === "") continue;
            const key = String(cmdId);
            if (!this.roles.has(key)) this.roles.set(key, []);
            this.roles.get(key).push(role);
        }
    }

    get id() {
        return this.spec.key;
    }

    get label() {
        return this.spec.name;
    }

    get levelMin() {
        return toNumber(this.spec.params?.levelMin) ?? 0;
    }

    get levelMax() {
        const max = toNumber(this.spec.params?.levelMax);
        if (max !== null && max > this.levelMin) return max;
        return Math.max(100, this.levelMin + 1);
    }

    /* Luminosité Jeedom (levelMin..levelMax) → niveau Matter (1..254). Null si éteinte : on garde le dernier niveau. */
    levelToMatter(value) {
        const number = toNumber(value);
        if (number === null || number <= this.levelMin) return null;
        const ratio = (number - this.levelMin) / (this.levelMax - this.levelMin);
        return clamp(Math.round(ratio * 254), 1, 254);
    }

    /* Niveau Matter → valeur du curseur Jeedom. Le niveau minimal reste allumé. */
    levelFromMatter(level) {
        const span = this.levelMax - this.levelMin;
        const value = this.levelMin + (level / 254) * span;
        return clamp(Math.round(value), this.levelMin + 1, this.levelMax);
    }

    /* Endpoint Matter, avec l'état initial tiré des valeurs Jeedom connues. */
    createEndpoint(values) {
        const state = {};
        if (this.kind.initial) mergeState(state, structuredClone(this.kind.initial));
        for (const [cmdId, roles] of this.roles) {
            if (!Object.hasOwn(values, cmdId)) continue;
            this.#values.set(cmdId, values[cmdId]);
            for (const role of roles) {
                const patch = this.kind.state(role, values[cmdId], this);
                if (patch) mergeState(state, patch);
            }
        }

        const name = matterString(this.spec.name);
        this.endpoint = new Endpoint(this.kind.type(), {
            id: this.spec.key,
            bridgedDeviceBasicInformation: {
                nodeLabel: name,
                productName: matterString(this.spec.productName || this.spec.name),
                productLabel: name,
                vendorName: "Jeedom",
                serialNumber: matterString(this.spec.key),
                /* Matter veut un uniqueId distinct du numéro de série. */
                uniqueId: createHash("md5").update(`jeedom-${this.spec.key}`).digest("hex"),
                /* Équipement désactivé dans Jeedom : gardé, mais signalé injoignable à Google. */
                reachable: this.spec.reachable !== false,
            },
            ...state,
        });
        registry.set(this.endpoint, this);
        return this.endpoint;
    }

    /* Nom et joignabilité, quand la configuration change sans changer d'appareil. */
    updateInfo(previous) {
        const patch = {};
        if (previous.name !== this.spec.name) {
            patch.nodeLabel = matterString(this.spec.name);
            patch.productLabel = matterString(this.spec.name);
        }
        if ((previous.reachable !== false) !== (this.spec.reachable !== false)) {
            patch.reachable = this.spec.reachable !== false;
        }
        if (!Object.keys(patch).length) return;
        return this.#enqueue(() => this.endpoint.set({ bridgedDeviceBasicInformation: patch }));
    }

    /*
     * Reprise d'un endpoint existant par un nouvel objet (commandes Jeedom
     * modifiées). La file d'écritures est reprise aussi : deux files sur le
     * même endpoint se croiseraient.
     */
    adopt(previous, values) {
        this.endpoint = previous.endpoint;
        this.#queue = previous.queue;
        this.#lastOnLevel = previous.lastOnLevel;
        registry.set(this.endpoint, this);
        this.applyValues(values);
    }

    get queue() {
        return this.#queue;
    }

    get lastOnLevel() {
        return this.#lastOnLevel;
    }

    /* Toutes les valeurs connues qui concernent cet appareil. */
    applyValues(values) {
        for (const cmdId of this.roles.keys()) {
            if (Object.hasOwn(values, cmdId)) this.applyValue(cmdId, values[cmdId]);
        }
    }

    unregister() {
        if (this.endpoint && registry.get(this.endpoint) === this) {
            registry.delete(this.endpoint);
        }
    }

    /* Les écritures sur un même endpoint passent une à une : matter.js refuse deux transactions croisées. */
    #enqueue(task) {
        this.#queue = this.#queue.then(task).catch(error => {
            log.warning(`${this.label} : mise à jour Matter impossible :`, error);
        });
        return this.#queue;
    }

    /* Nouvelle valeur d'une commande info Jeedom. */
    applyValue(cmdId, value) {
        const key = String(cmdId);
        const roles = this.roles.get(key);
        if (!roles || !this.endpoint) return;
        this.#values.set(key, value);
        const state = {};
        for (const role of roles) {
            const patch = this.kind.state(role, value, this);
            if (patch) mergeState(state, patch);
        }
        if (!Object.keys(state).length) return;
        if (state.levelControl?.currentLevel > 1) this.#lastOnLevel = state.levelControl.currentLevel;
        log.debug(`${this.label} ← Jeedom ${key}=${value}`, state);
        return this.#enqueue(() => this.endpoint.set(state));
    }

    /* Remet dans Matter les dernières valeurs Jeedom, après une commande refusée. */
    #restore() {
        for (const [cmdId, value] of this.#values) {
            this.applyValue(cmdId, value);
        }
    }

    recentlyTurnedOff() {
        return Date.now() - this.#lastOff < OFF_SUPPRESSION_MS;
    }

    /* Exécution d'une commande Jeedom, sans faire attendre le contrôleur Matter. */
    #exec(cmdId, options, what) {
        if (!cmdId) {
            log.warning(`${this.label} : aucune commande Jeedom pour « ${what} »`);
            this.#restore();
            return;
        }
        log.info(`${this.label} : ${what} (commande ${cmdId}${options && Object.keys(options).length ? " " + JSON.stringify(options) : ""})`);
        return this.#link.exec(cmdId, options).catch(error => {
            log.error(`${this.label} : « ${what} » refusé par Jeedom :`, error);
            this.#restore();
        });
    }

    commandOnOff(on) {
        const { cmds } = this.spec;
        if (!on) {
            this.#lastOff = Date.now();
        }
        if (on && cmds.on) return this.#exec(cmds.on, {}, "allumer");
        if (!on && cmds.off) return this.#exec(cmds.off, {}, "éteindre");

        /* Variateur sans boutons : on passe par le curseur, et on rallume au dernier niveau allumé, jamais à 1 %. */
        if (cmds.setLevel) {
            if (!on) return this.#exec(cmds.setLevel, { slider: this.levelMin }, "éteindre");
            return this.#exec(cmds.setLevel, { slider: this.levelFromMatter(this.#lastOnLevel) }, "allumer");
        }
        return this.#exec(null, {}, on ? "allumer" : "éteindre");
    }

    commandLevel(level, withOnOff, isOn) {
        const { cmds } = this.spec;

        if (withOnOff && level <= 1) {
            return this.commandOnOff(false);
        }
        /* Un simple réglage sur une lampe éteinte n'est que mémorisé, comme le veut Matter. */
        if (!withOnOff && !isOn) {
            return;
        }
        if (level > 1) this.#lastOnLevel = level;
        const run = async () => {
            if (withOnOff && !isOn && cmds.on) {
                await this.#exec(cmds.on, {}, "allumer");
            }
            await this.#exec(cmds.setLevel, { slider: this.levelFromMatter(level) }, `luminosité ${Math.round((level / 254) * 100)} %`);
        };
        return run();
    }
}
