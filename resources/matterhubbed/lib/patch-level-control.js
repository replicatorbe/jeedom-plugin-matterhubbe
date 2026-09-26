/*
 * Google Home envoie moveToLevel, moveToLevelWithOnOff, step et stepWithOnOff
 * sans le champ transitionTime quand on règle la luminosité d'une lampe déjà
 * allumée. La spécification le déclare « nullable », matter.js le déclare
 * obligatoire : la commande est rejetée avant d'atteindre le code du plugin et
 * le curseur de Google revient en arrière.
 *
 * On rend le champ facultatif dans les schémas. Le code du plugin traite une
 * durée absente comme une transition immédiate.
 *
 * SPDX-License-Identifier: Apache-2.0
 * Adapté de home-assistant-matter-hub, Copyright les contributeurs de
 * home-assistant-matter-hub (t0bst4r, RiDDiX), sous licence Apache 2.0
 * (texte dans LICENSES/Apache-2.0.txt) :
 * packages/backend/src/matter/patches/patch-level-control-tlv.ts, issue #41,
 * commit 614f8c9. Modifications : réécrit de TypeScript en JavaScript,
 * application à l'import et contrôle sur le schéma du serveur réellement utilisé.
 */

import { LevelControl } from "@matter/main/clusters/level-control";
import { log } from "./log.js";

const optionalFields = new WeakSet();
let prototypePatched = false;

function forceOptionalViaPrototype(field) {
    optionalFields.add(field);
    if (!prototypePatched) {
        let proto = Object.getPrototypeOf(field);
        while (proto) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, "mandatory");
            if (descriptor?.get && descriptor.configurable) {
                const original = descriptor.get;
                Object.defineProperty(proto, "mandatory", {
                    configurable: true,
                    get() {
                        return optionalFields.has(this) ? false : original.call(this);
                    },
                });
                prototypePatched = true;
                break;
            }
            proto = Object.getPrototypeOf(proto);
        }
    }
    return field.mandatory === false;
}

function markOptional(field) {
    if (!field) {
        return false;
    }
    try {
        if (typeof field.patch === "function") {
            field.patch({ conformance: "O" });
        }
    } catch {
        /* On tente les autres moyens. */
    }
    try {
        field.optional = true;
    } catch {
        /* idem */
    }
    try {
        Object.defineProperty(field, "mandatory", { configurable: true, value: false, writable: true });
    } catch {
        /* idem */
    }
    return field.mandatory === false || forceOptionalViaPrototype(field);
}

function findTransitionTime(fields, fallbackIndex) {
    return fields?.find(f => f.name === "TransitionTime" || f.propertyName === "transitionTime") ?? fields?.[fallbackIndex];
}

/*
 * Appliqué à l'import, et ce module doit être importé AVANT tout module qui
 * dérive LevelControlServer (lib/devices.js) : une classe dérivée fige son
 * schéma à sa création, un correctif posé après ne l'atteint plus.
 */
export const levelControlPatched = patchLevelControl();

function patchLevelControl() {
    let patched = 0;
    if (markOptional(LevelControl.MoveToLevelRequest?.fieldDefinitions?.transitionTime)) patched++;
    if (markOptional(LevelControl.StepRequest?.fieldDefinitions?.transitionTime)) patched++;
    if (markOptional(findTransitionTime(LevelControl.commands?.moveToLevel?.schema?.children, 1))) patched++;
    if (markOptional(findTransitionTime(LevelControl.commands?.step?.schema?.children, 2))) patched++;

    return patched;
}

/* Contrôle sur le schéma réellement utilisé par le serveur, pas seulement sur le cluster de base. */
export function checkLevelControlPatch(serverClass) {
    const commands = serverClass?.schema?.commands ?? [];
    const failing = [];
    for (const name of ["MoveToLevel", "Step"]) {
        const command = commands.find(c => c.name === name && c.isRequest);
        const field = command?.properties?.find(f => f.name === "TransitionTime");
        if (!field || field.mandatory !== false) failing.push(name);
    }
    if (levelControlPatched === 0 || failing.length) {
        log.warning(`Correctif LevelControl inopérant (${failing.join(", ") || "aucun schéma trouvé"}) : le réglage de luminosité depuis Google Home peut échouer`);
    } else {
        log.debug("Correctif LevelControl actif : transitionTime facultatif pour Google Home");
    }
}
