/*
 * Un pont Matter : un ServerNode matter.js (son port, ses contrôleurs, son code
 * d'appairage) portant un Aggregator, sous lequel chaque appareil Jeedom est un
 * endpoint.
 *
 * Numéros d'endpoint : matter.js associe l'identifiant texte de l'endpoint
 * (eq<id>-<type>) à un numéro qu'il conserve. Tant que l'identifiant ne change
 * pas, Google garde l'appareil, son nom et sa pièce. On ne supprime donc un
 * endpoint (delete, qui oublie le numéro) que lorsque l'utilisateur a retiré
 * l'appareil du pont ; un arrêt ne fait que fermer.
 */

import { createHash } from "node:crypto";
import { CommissioningServer, Endpoint, Seconds, ServerNode, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { Device, isSupportedKind } from "./devices.js";
import { log } from "./log.js";
import { qrSvg } from "./qr.js";

/* Identifiants de test de la CSA : un pont non certifié doit les utiliser. */
const VENDOR_ID = 0xfff1;
const PRODUCT_ID = 0x8000;

/*
 * Au-delà de 60 s entre deux rapports, Google abandonne la souscription ; en
 * dessous de 2 s, les rafales de valeurs saturent le réseau
 * (home-assistant-matter-hub #386).
 */
const SUBSCRIPTION_OPTIONS = { minInterval: Seconds(2), maxInterval: Seconds(60), randomizationWindow: Seconds(0) };

function truncate(text, max) {
    let out = String(text ?? "").trim();
    while (Buffer.byteLength(out, "utf8") > max) out = out.slice(0, -1);
    return out;
}

export class Bridge {
    #link;
    #server = null;
    #aggregator = null;
    #devices = new Map();
    #onStatus;

    constructor(config, link, onStatus) {
        this.config = config;
        this.#link = link;
        this.#onStatus = onStatus;
    }

    get id() {
        return this.config.id;
    }

    get label() {
        return `Pont « ${this.config.name} »`;
    }

    /* Un changement de port ou de nom impose de recréer le nœud. */
    needsRestart(config) {
        return config.port !== this.config.port || config.name !== this.config.name;
    }

    async start(values) {
        const id = `bridge-${this.config.id}`;
        const name = truncate(this.config.name || "Jeedom", 32) || "Jeedom";

        this.#server = await ServerNode.create({
            id,
            network: { port: this.config.port, subscriptionOptions: SUBSCRIPTION_OPTIONS },
            productDescription: { name, deviceType: AggregatorEndpoint.deviceType },
            basicInformation: {
                vendorName: "Jeedom",
                vendorId: VendorId(VENDOR_ID),
                productId: PRODUCT_ID,
                productName: "Matter Hub",
                productLabel: "Matter Hub",
                nodeLabel: name,
                serialNumber: createHash("md5").update(`serial-${id}`).digest("hex"),
                uniqueId: id,
                hardwareVersion: 1,
                softwareVersion: 1,
                softwareVersionString: "1",
            },
            subscriptions: { persistenceEnabled: false },
        });

        this.#aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
        await this.#server.add(this.#aggregator);

        for (const spec of this.config.devices ?? []) {
            await this.#addDevice(spec, values);
        }

        const commissioning = this.#server.events.commissioning;
        commissioning.commissioned.on(() => this.#statusChanged("appairé"));
        commissioning.decommissioned.on(() => this.#statusChanged("plus aucun contrôleur"));
        commissioning.fabricsChanged.on(() => this.#statusChanged());

        await this.#server.start();
        log.info(`${this.label} démarré sur le port ${this.config.port} avec ${this.#devices.size} appareil(s)`);
        this.#statusChanged();
    }

    #statusChanged(event) {
        if (event) log.info(`${this.label} : ${event}`);
        this.#onStatus(this);
    }

    async #addDevice(spec, values) {
        if (!isSupportedKind(spec.kind)) {
            log.warning(`${this.label} : type inconnu « ${spec.kind} » pour ${spec.name}`);
            return;
        }
        const device = new Device(spec, this.#link);
        try {
            await this.#aggregator.add(device.createEndpoint(values));
            this.#devices.set(spec.key, device);
            log.debug(`${this.label} : + ${spec.name} (${spec.kind}, ${spec.key})`);
        } catch (error) {
            device.unregister();
            log.error(`${this.label} : ${spec.name} ne peut pas être exposé :`, error);
        }
    }

    /* Nouvelle configuration du même pont (même port, même nom) : appareils ajoutés, retirés, renommés. */
    async sync(config, values) {
        this.config = config;
        const wanted = new Map((config.devices ?? []).map(spec => [spec.key, spec]));

        for (const [key, device] of this.#devices) {
            if (wanted.has(key)) continue;
            this.#devices.delete(key);
            device.unregister();
            try {
                await device.endpoint.delete();
                log.info(`${this.label} : ${device.label} retiré`);
            } catch (error) {
                log.warning(`${this.label} : retrait de ${device.label} :`, error);
            }
        }

        for (const [key, spec] of wanted) {
            const device = this.#devices.get(key);
            if (!device) {
                await this.#addDevice(spec, values);
                continue;
            }
            const previous = device.spec;
            if (new Device(spec, this.#link).structureKey !== device.structureKey) {
                /*
                 * Forme changée (bornes, couleur ajoutée…) : l'endpoint est
                 * recréé sous le même identifiant. close() et non delete() :
                 * matter.js garde ainsi son numéro, et Google l'appareil.
                 */
                this.#devices.delete(key);
                device.unregister();
                try {
                    await device.endpoint.close();
                } catch (error) {
                    log.warning(`${this.label} : fermeture de ${device.label} :`, error);
                }
                log.info(`${this.label} : ${spec.name} recréé (caractéristiques modifiées)`);
                await this.#addDevice(spec, values);
                continue;
            }
            const rewired = JSON.stringify(previous.cmds) !== JSON.stringify(spec.cmds)
                || JSON.stringify(previous.params) !== JSON.stringify(spec.params);
            let current = device;
            if (rewired) {
                /* Mêmes identifiant et type, autres commandes : nouvel objet, même endpoint. */
                current = new Device(spec, this.#link);
                device.unregister();
                current.adopt(device, values);
                this.#devices.set(key, current);
            } else {
                device.spec = spec;
            }
            current.updateInfo(previous);
        }
        this.#statusChanged();
    }

    /* Toutes les valeurs connues, après un démarrage ou une réinitialisation. */
    applyValues(values) {
        for (const device of this.#devices.values()) device.applyValues(values);
    }

    /* Valeur Jeedom reçue : chaque appareil qui l'écoute se met à jour. */
    applyValue(cmdId, value) {
        for (const device of this.#devices.values()) {
            if (device.roles.has(String(cmdId))) {
                device.applyValue(cmdId, value);
            }
        }
    }

    cmdIds() {
        const ids = new Set();
        for (const device of this.#devices.values()) {
            for (const id of device.roles.keys()) ids.add(id);
        }
        return ids;
    }

    status() {
        const out = { id: this.config.id, port: this.config.port, running: false, devices: this.#devices.size };
        if (!this.#server) return out;
        try {
            const commissioning = this.#server.state.commissioning;
            const fabrics = this.#server.state.operationalCredentials.fabrics ?? [];
            out.running = this.#server.lifecycle.isOnline;
            out.commissioned = !!commissioning.commissioned;
            out.qrPairingCode = commissioning.pairingCodes?.qrPairingCode ?? "";
            out.manualPairingCode = commissioning.pairingCodes?.manualPairingCode ?? "";
            out.qrSvg = qrSvg(out.qrPairingCode);
            out.fabrics = fabrics.map(f => ({ index: f.fabricIndex, vendorId: f.vendorId, label: f.label }));
        } catch (error) {
            log.debug(`${this.label} : état illisible :`, error);
        }
        return out;
    }

    /*
     * Fenêtre d'appairage sur un pont déjà appairé : c'est ainsi qu'on ajoute un
     * second contrôleur, ou qu'on réappaire Google sans tout effacer.
     */
    async openCommissioning() {
        if (!this.#server?.state.commissioning.commissioned) {
            return "Le pont n'est pas encore appairé : son code est déjà utilisable.";
        }
        await this.#server.act(agent => agent.get(CommissioningServer).enterCommissionableMode());
        log.info(`${this.label} : fenêtre d'appairage ouverte pour 15 minutes`);
        this.#statusChanged();
        return "";
    }

    /* Oublie tous les contrôleurs (et les clés de session) ; le nœud redémarre seul. */
    async factoryReset(values) {
        if (!this.#server) return;
        log.warning(`${this.label} : réinitialisation, tous les contrôleurs sont oubliés`);
        await this.#server.erase();
        /* erase() remet les endpoints à leur état de construction : on y remet l'état réel. */
        this.applyValues(values);
        this.#statusChanged();
    }

    async stop() {
        for (const device of this.#devices.values()) device.unregister();
        this.#devices.clear();
        if (this.#server) {
            try {
                await this.#server.close();
            } catch (error) {
                log.warning(`${this.label} : arrêt :`, error);
            }
        }
        this.#server = null;
        this.#aggregator = null;
    }
}
