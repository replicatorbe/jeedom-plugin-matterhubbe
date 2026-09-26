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
import { ColorControlServer } from "@matter/main/behaviors/color-control";
import { DoorLockServer } from "@matter/main/behaviors/door-lock";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { MovementDirection, MovementType, WindowCoveringServer } from "@matter/main/behaviors/window-covering";
import { ColorControl } from "@matter/main/clusters/color-control";
import { DoorLock } from "@matter/main/clusters/door-lock";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { WindowCovering } from "@matter/main/clusters/window-covering";
import { ColorTemperatureLightDevice } from "@matter/main/devices/color-temperature-light";
import { DoorLockDevice } from "@matter/main/devices/door-lock";
import { ExtendedColorLightDevice } from "@matter/main/devices/extended-color-light";
import { ThermostatDevice } from "@matter/main/devices/thermostat";
import { WindowCoveringDevice } from "@matter/main/devices/window-covering";
import { hasLocalActor } from "@matter/main/protocol";
import { hsToRgb, kelvinToMireds, miredsToKelvin, parseHex, rgbToHs, rgbToXy, toHex, xyToRgb } from "./color.js";
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

/*
 * Volet. Toutes les commandes (upOrOpen, downOrClose, goToLiftPercentage)
 * aboutissent à handleMovement, avec la cible déjà écrite. On n'appelle pas
 * super : il « téléporterait » la position à la cible, alors que c'est Jeedom
 * qui dira où le volet est réellement.
 */
class JeedomWindowCoveringServer extends WindowCoveringServer.with("Lift", "PositionAwareLift") {
    handleMovement(type, _reversed, direction, targetPercent100ths) {
        if (type === MovementType.Lift) {
            deviceOf(this)?.commandCover(targetPercent100ths, direction);
        }
    }

    handleStopMovement() {
        deviceOf(this)?.commandCoverStop();
        return super.handleStopMovement();
    }
}

/*
 * Thermostat, chauffage seul. Google écrit la consigne et le mode comme des
 * attributs, sans commande : on observe les écritures ($Changing) et on
 * écarte celles qui viennent de Jeedom lui-même (acteur local). setpointRaiseLower
 * écrit la même consigne et passe donc aussi par ici.
 *
 * Les observateurs n'ont pas de valeur de retour : matter.js interrompt la
 * diffusion d'un événement dès qu'un observateur renvoie quelque chose.
 */
class JeedomThermostatServer extends ThermostatServer.with("Heating") {
    async initialize() {
        await super.initialize();
        this.reactTo(this.events.occupiedHeatingSetpoint$Changing, this.#setpointChanging);
        this.reactTo(this.events.systemMode$Changing, this.#systemModeChanging);
    }

    #setpointChanging(value, _old, context) {
        if (!hasLocalActor(context)) {
            deviceOf(this)?.commandSetpoint(value / 100);
        }
    }

    #systemModeChanging(value, _old, context) {
        if (!hasLocalActor(context)) {
            deviceOf(this)?.commandSystemMode(value);
        }
    }
}

/*
 * Serrure sans aucune option (ni code, ni utilisateurs). On n'appelle pas
 * super : il comparerait un éventuel code envoyé par le contrôleur à une liste
 * vide et répondrait « échec ».
 */
class JeedomDoorLockServer extends DoorLockServer.with() {
    lockDoor() {
        this.#command(true);
    }

    unlockDoor() {
        this.#command(false);
    }

    /*
     * Pas d'état optimiste quand Jeedom sait dire l'état réel : une serrure
     * coincée afficherait « verrouillée » dans Google alors qu'elle ne l'est
     * pas. Google voit le nouvel état quand Jeedom le confirme.
     */
    #command(lock) {
        const device = deviceOf(this);
        if (device && !device.spec.cmds.state) {
            this.state.lockState = lock ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;
        }
        device?.commandLock(lock);
    }
}

/*
 * Couleur. Pas de point de passage unique : teinte et saturation séparées
 * sont ramenées à moveToHueAndSaturationLogic (un seul ordre Jeedom), xy et
 * température de couleur ont chacune le leur. Le mode de couleur est déjà
 * posé par la commande avant ces méthodes.
 */
function colorServer(withHs) {
    /* Lampe à blanc réglable seule : température de couleur uniquement, sinon Google proposerait une roue des couleurs. */
    const features = withHs ? ["HueSaturation", "Xy", "ColorTemperature"] : ["ColorTemperature"];
    return class JeedomColorControlServer extends ColorControlServer.with(...features) {
        moveToHueLogic(hue) {
            return this.moveToHueAndSaturationLogic(hue, this.state.currentSaturation ?? 254);
        }

        moveToSaturationLogic(saturation) {
            return this.moveToHueAndSaturationLogic(this.state.currentHue ?? 0, saturation);
        }

        moveToHueAndSaturationLogic(hue, saturation) {
            this.state.currentHue = hue;
            this.state.currentSaturation = saturation;
            deviceOf(this)?.commandColor(toHex(hsToRgb(hue, saturation)), "teinte/saturation");
        }

        moveToColorLogic(x, y) {
            this.state.currentX = x;
            this.state.currentY = y;
            deviceOf(this)?.commandColor(toHex(xyToRgb(x, y)), "couleur xy");
        }

        moveToColorTemperatureLogic(mireds, transitionTime) {
            const result = super.moveToColorTemperatureLogic(mireds, transitionTime);
            deviceOf(this)?.commandColorTemperature(this.state.colorTemperatureMireds);
            return result;
        }
    };
}
const ColorServerHs = colorServer(true);
const ColorServerCt = colorServer(false);

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

    cover: {
        type: () => WindowCoveringDevice.with(BridgedInfo, JeedomWindowCoveringServer),
        initial: () => ({
            windowCovering: {
                type: WindowCovering.WindowCoveringType.Rollershade,
                endProductType: WindowCovering.EndProductType.RollerShutter,
            },
        }),
        state(role, value, device) {
            if (role !== "state") return null;
            const position = device.coverToMatter(value);
            if (position === null) return null;
            return { windowCovering: device.coverPositionPatch(position) };
        },
    },

    thermostat: {
        type: () => ThermostatDevice.with(BridgedInfo, JeedomThermostatServer),
        initial: device => {
            const [min, max] = device.setpointRange;
            return {
                thermostat: {
                    controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
                    systemMode: Thermostat.SystemMode.Heat,
                    /* Limites absolues, puis limites utilisateur, puis consigne : l'ordre que matter.js vérifie. */
                    absMinHeatSetpointLimit: min,
                    absMaxHeatSetpointLimit: max,
                    minHeatSetpointLimit: min,
                    maxHeatSetpointLimit: max,
                    occupiedHeatingSetpoint: clamp(2000, min, max),
                    localTemperature: null,
                    ...(device.spec.cmds.state ? { thermostatRunningState: { heat: false, cool: false, fan: false } } : {}),
                },
            };
        },
        state(role, value, device) {
            const number = toNumber(value);
            if (role === "temperature") {
                return { thermostat: { localTemperature: number === null ? null : clamp(Math.round(number * 100), -27315, 32767) } };
            }
            if (role === "setpoint" && number !== null) {
                const [min, max] = device.setpointRange;
                return { thermostat: { occupiedHeatingSetpoint: clamp(Math.round(number * 100), min, max) } };
            }
            if (role === "state") {
                return { thermostat: { thermostatRunningState: { heat: toBool(value), cool: false, fan: false } } };
            }
            if (role === "mode") {
                return { thermostat: { systemMode: device.modeToSystemMode(value) } };
            }
            return null;
        },
    },

    lock: {
        type: () => DoorLockDevice.with(BridgedInfo, JeedomDoorLockServer),
        initial: () => ({
            doorLock: {
                lockType: DoorLock.LockType.DeadBolt,
                actuatorEnabled: true,
                operatingMode: DoorLock.OperatingMode.Normal,
                lockState: null,
            },
        }),
        /* Jeedom : 1 = verrouillée (widget « lock » du cœur, plugins officiels). */
        state(role, value, device) {
            if (role !== "state") return null;
            const locked = toBool(value) !== !!device.spec.params.invert;
            return { doorLock: { lockState: locked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked } };
        },
    },

    color_light: {
        type: device => device.spec.params.hasColor
            ? ExtendedColorLightDevice.with(BridgedInfo, JeedomOnOffServer, JeedomLevelControlServer, ColorServerHs)
            : ColorTemperatureLightDevice.with(BridgedInfo, JeedomOnOffServer, JeedomLevelControlServer, ColorServerCt),
        initial: device => {
            const [minMireds, maxMireds] = device.miredsRange;
            const hs = !!device.spec.params.hasColor;
            const mode = hs ? ColorControl.ColorMode.CurrentHueAndCurrentSaturation : ColorControl.ColorMode.ColorTemperatureMireds;
            return {
                levelControl: { currentLevel: 254 },
                colorControl: {
                    /* Sans cette option, une couleur choisie lampe éteinte est ignorée en silence. */
                    options: { executeIfOff: true },
                    colorTempPhysicalMinMireds: minMireds,
                    colorTempPhysicalMaxMireds: maxMireds,
                    coupleColorTempToLevelMinMireds: minMireds,
                    colorTemperatureMireds: clamp(250, minMireds, maxMireds),
                    colorMode: mode,
                    enhancedColorMode: mode,
                    ...(hs ? { currentHue: 0, currentSaturation: 0 } : {}),
                },
            };
        },
        state(role, value, device) {
            const out = KINDS.dimmable_light.state(role, value, device) ?? {};
            if (role === "color" && device.spec.params.hasColor) {
                const rgb = parseHex(value);
                if (rgb) {
                    const { hue, saturation } = rgbToHs(rgb);
                    const { x, y } = rgbToXy(rgb);
                    /* Jeedom ne dit pas quel mode est actif : on suit la dernière valeur reçue. */
                    const mode = ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
                    out.colorControl = { currentHue: hue, currentSaturation: saturation, currentX: x, currentY: y, colorMode: mode, enhancedColorMode: mode };
                }
            }
            if (role === "colorTemp") {
                const mireds = device.colorTempToMireds(value);
                if (mireds !== null) {
                    const mode = ColorControl.ColorMode.ColorTemperatureMireds;
                    out.colorControl = { colorTemperatureMireds: mireds, colorMode: mode, enhancedColorMode: mode };
                }
            }
            return Object.keys(out).length ? out : null;
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
    #coverTarget = null;
    #coverTimer = null;
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
        const initial = typeof this.kind.initial === "function" ? this.kind.initial(this) : this.kind.initial;
        if (initial) mergeState(state, structuredClone(initial));
        for (const [cmdId, roles] of this.roles) {
            if (!Object.hasOwn(values, cmdId)) continue;
            this.#values.set(cmdId, values[cmdId]);
            for (const role of roles) {
                const patch = this.kind.state(role, values[cmdId], this);
                if (patch) mergeState(state, patch);
            }
        }

        const name = matterString(this.spec.name);
        this.endpoint = new Endpoint(this.kind.type(this), {
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

    /*
     * Écriture Matter différée, hors de la transaction de la commande en
     * cours : écrire pendant qu'elle tient le verrou de l'endpoint échouerait.
     */
    #later(state) {
        setTimeout(() => {
            if (this.endpoint) this.#enqueue(() => this.endpoint.set(state));
        }, 300);
    }

    /*
     * Ce qui fixe la forme de l'endpoint à sa création (features, bornes,
     * attributs facultatifs). S'il change, l'endpoint doit être recréé : le
     * modifier en place violerait ses contraintes.
     */
    get structureKey() {
        const { kind, params = {}, cmds = {} } = this.spec;
        return JSON.stringify({
            kind,
            hasColor: kind === "color_light" ? !!params.hasColor : undefined,
            mireds: kind === "color_light" ? this.miredsRange : undefined,
            setpoint: kind === "thermostat" ? this.setpointRange : undefined,
            running: kind === "thermostat" ? !!cmds.state : undefined,
        });
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

    /* ---------------------------------------------------------- volet */

    /*
     * Position Jeedom → Matter. Jeedom : 0 = fermé, 100 = ouvert, à l'échelle
     * du curseur (0..99 pour certains modules), ou binaire 1 = ouvert. Matter :
     * 0 = ouvert, 10000 = fermé, en centièmes de pour cent.
     */
    coverToMatter(value) {
        let open;
        if (this.spec.params.stateBinary) {
            open = toBool(value) ? 100 : 0;
        } else {
            const number = toNumber(value);
            if (number === null) return null;
            open = clamp(((number - this.levelMin) / (this.levelMax - this.levelMin)) * 100, 0, 100);
        }
        if (this.spec.params.invert) open = 100 - open;
        return clamp(Math.round((100 - open) * 100), 0, 10000);
    }

    /*
     * La cible suit la position quand le volet est au repos : sinon Google le
     * croit toujours en mouvement. Après un ordre de Google, la cible est
     * gardée jusqu'à ce que Jeedom l'annonce atteinte (à 1 % près), ou deux
     * minutes au plus.
     */
    coverPositionPatch(position) {
        const pending = this.#coverTarget;
        if (pending && Date.now() - pending.at < 120_000 && Math.abs(position - pending.target) > 100) {
            return { currentPositionLiftPercent100ths: position };
        }
        this.#coverTarget = null;
        clearTimeout(this.#coverTimer);
        return { currentPositionLiftPercent100ths: position, targetPositionLiftPercent100ths: position };
    }

    commandCover(target, direction) {
        const { cmds } = this.spec;
        if (typeof target === "number") {
            this.#coverTarget = { target, at: Date.now() };
            this.#settleCover(target);
        }
        const openTarget = typeof target === "number" ? 100 - target / 100 : null;
        const wantsOpen = openTarget !== null ? openTarget >= 50 : direction === MovementDirection.Open;

        /* Tout ouvert ou tout fermé : les boutons, plus sûrs qu'un curseur mal calibré. */
        if ((openTarget === null || openTarget === 100) && wantsOpen && cmds.up) return this.#exec(cmds.up, {}, "ouvrir");
        if ((openTarget === null || openTarget === 0) && !wantsOpen && cmds.down) return this.#exec(cmds.down, {}, "fermer");

        if (openTarget !== null && cmds.setLevel) {
            const open = this.spec.params.invert ? 100 - openTarget : openTarget;
            const slider = Math.round(this.levelMin + (open / 100) * (this.levelMax - this.levelMin));
            return this.#exec(cmds.setLevel, { slider }, `position ${Math.round(openTarget)} %`);
        }
        /* Sans curseur, une position intermédiaire devient ouvrir ou fermer. */
        return this.#exec(wantsOpen ? cmds.up : cmds.down, {}, wantsOpen ? "ouvrir" : "fermer");
    }

    commandCoverStop() {
        this.#coverTarget = null;
        clearTimeout(this.#coverTimer);
        return this.#exec(this.spec.cmds.stop, {}, "arrêter");
    }

    /*
     * Matter garde le volet « en mouvement » tant que sa position n'égale pas
     * la cible. Sans info d'état, ou si Jeedom ne répond rien (volet déjà en
     * place, cible manquée), on réaligne nous-mêmes : tout de suite sans info
     * d'état, au bout de deux minutes sinon.
     */
    #settleCover(target) {
        clearTimeout(this.#coverTimer);
        const stopped = { global: 0, lift: 0, tilt: 0 };
        if (!this.spec.cmds.state) {
            this.#later({ windowCovering: { currentPositionLiftPercent100ths: target, operationalStatus: stopped } });
            return;
        }
        const current = this.endpoint?.state?.windowCovering?.currentPositionLiftPercent100ths;
        if (current === target) {
            this.#later({ windowCovering: { operationalStatus: stopped } });
            return;
        }
        this.#coverTimer = setTimeout(() => {
            this.#coverTarget = null;
            const position = this.endpoint?.state?.windowCovering?.currentPositionLiftPercent100ths;
            if (typeof position === "number") {
                this.#enqueue(() => this.endpoint.set({ windowCovering: { targetPositionLiftPercent100ths: position, operationalStatus: stopped } }));
            }
        }, 120_000);
        this.#coverTimer.unref?.();
    }

    /* ---------------------------------------------------------- thermostat */

    /* Plage de consigne en centièmes de degré, d'après le curseur Jeedom (7..30 °C par défaut). */
    get setpointRange() {
        const min = toNumber(this.spec.params.setpointMin);
        const max = toNumber(this.spec.params.setpointMax);
        const lo = min !== null ? min : 7;
        const hi = max !== null && max > lo ? max : Math.max(30, lo + 1);
        return [Math.round(lo * 100), Math.round(hi * 100)];
    }

    /* Mode Jeedom (THERMOSTAT_MODE, texte) → mode Matter : Off s'il nomme le mode « arrêt », Heat sinon. */
    modeToSystemMode(value) {
        const text = String(value ?? "").trim().toLowerCase();
        const labels = (this.spec.params.offLabels ?? []).map(l => String(l).trim().toLowerCase());
        const isOff = labels.includes(text) || /^(off|arr[eê]t|arr[eê]t[ée]|aus|stop)$/.test(text);
        return isOff ? Thermostat.SystemMode.Off : Thermostat.SystemMode.Heat;
    }

    commandSetpoint(celsius) {
        const step = toNumber(this.spec.params.setpointStep) || 0.5;
        const [min, max] = this.setpointRange;
        const value = Number(clamp(Math.round(celsius / step) * step, min / 100, max / 100).toFixed(2));
        /* Google a pu écrire 21,3 alors que Jeedom reçoit 21,5 : Matter doit afficher ce qui est réellement demandé. */
        if (Math.round(value * 100) !== Math.round(celsius * 100)) {
            this.#later({ thermostat: { occupiedHeatingSetpoint: Math.round(value * 100) } });
        }
        return this.#exec(this.spec.cmds.setSetpoint, { slider: value }, `consigne ${value} °C`);
    }

    commandSystemMode(mode) {
        const { params } = this.spec;
        const target = mode === Thermostat.SystemMode.Off ? params.offMode : params.heatMode;
        const what = mode === Thermostat.SystemMode.Off ? "arrêt" : "chauffage";
        if (!target) {
            log.warning(`${this.label} : aucun mode Jeedom associé à « ${what} »`);
            /* Rien ne ramènerait le mode : on le remet nous-mêmes sur celui qui est réel. */
            this.#later({ thermostat: { systemMode: mode === Thermostat.SystemMode.Off ? Thermostat.SystemMode.Heat : Thermostat.SystemMode.Off } });
            return;
        }
        /* Soit une action par mode, soit une seule action « liste » avec la valeur du mode. */
        if (target.select) return this.#exec(target.cmd, { select: target.select }, what);
        return this.#exec(target.cmd, {}, what);
    }

    /* ---------------------------------------------------------- serrure */

    commandLock(lock) {
        const { cmds } = this.spec;
        return this.#exec(lock ? cmds.lock : cmds.unlock, {}, lock ? "verrouiller" : "déverrouiller");
    }

    /* ---------------------------------------------------------- couleur */

    /* Plage de température de couleur en mireds, d'après le curseur Jeedom (kelvins ou mireds). */
    get miredsRange() {
        const { params } = this.spec;
        const lo = toNumber(params.ctMin);
        const hi = toNumber(params.ctMax);
        let range;
        if (lo !== null && hi !== null && hi > lo) {
            range = params.ctKelvin ? [kelvinToMireds(hi), kelvinToMireds(lo)] : [Math.round(lo), Math.round(hi)];
        } else {
            range = [153, 500];
        }
        return [clamp(range[0], 1, 65279), clamp(Math.max(range[1], range[0] + 1), 1, 65279)];
    }

    colorTempToMireds(value) {
        const number = toNumber(value);
        if (number === null || number <= 0) return null;
        const mireds = this.spec.params.ctKelvin ? kelvinToMireds(number) : Math.round(number);
        const [min, max] = this.miredsRange;
        return clamp(mireds, min, max);
    }

    commandColor(hex, what) {
        return this.#exec(this.spec.cmds.setColor, { color: hex }, `${what} ${hex}`);
    }

    commandColorTemperature(mireds) {
        if (!this.spec.cmds.setColorTemp) {
            log.warning(`${this.label} : pas de commande Jeedom de température de couleur`);
            this.#restore();
            return;
        }
        /* L'aller-retour kelvins → mireds → kelvins peut sortir des bornes du curseur (6400 K → 156 → 6410 K). */
        let value = this.spec.params.ctKelvin ? miredsToKelvin(mireds) : mireds;
        const lo = toNumber(this.spec.params.ctMin);
        const hi = toNumber(this.spec.params.ctMax);
        if (lo !== null && hi !== null && hi > lo) value = clamp(value, lo, hi);
        return this.#exec(this.spec.cmds.setColorTemp, { slider: value }, `température de couleur ${miredsToKelvin(mireds)} K`);
    }
}
