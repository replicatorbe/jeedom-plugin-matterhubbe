/*
 * Dialogue avec le callback PHP du plugin (core/php/jeeMatterhubbe.php).
 *
 * Le démon ne charge jamais le cœur de Jeedom : il lit sa configuration, suit
 * les changements de valeur et fait exécuter les commandes par ce seul point
 * d'entrée, protégé par la clé API du plugin.
 */

import { log } from "./log.js";

export class JeedomLink {
    #callback;
    #apikey;

    constructor(callback, apikey) {
        this.#callback = callback;
        this.#apikey = apikey;
    }

    #url(params) {
        const url = new URL(this.#callback);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, String(value));
        }
        return url;
    }

    async #request(params, body, timeoutMs) {
        let response;
        try {
            response = await this.#fetch(params, body, timeoutMs);
        } catch (error) {
            /* « fetch failed » seul ne dit rien : la vraie cause (ECONNREFUSED, délai…) est dans error.cause. */
            const cause = error?.cause?.code ?? error?.cause?.message;
            throw new Error(cause ? `${error.message} (${cause})` : error.message);
        }
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} : ${text.slice(0, 200)}`);
        }
        return text;
    }

    #fetch(params, body, timeoutMs) {
        return fetch(this.#url(params), {
            method: body === undefined ? "GET" : "POST",
            /* La clé en en-tête, pas dans l'URL : elle finirait dans le journal d'accès d'Apache. */
            headers: {
                "X-Matterhubbe-Key": this.#apikey,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    }

    async #json(params, body, timeoutMs) {
        const text = await this.#request(params, body, timeoutMs);
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`réponse illisible : ${text.slice(0, 200)}`);
        }
    }

    /* Configuration complète : ponts, appareils, valeurs courantes et curseur d'événements. */
    getConfig() {
        return this.#json({ action: "config" }, undefined, 30_000);
    }

    /*
     * Attente longue côté PHP (event::changes). Le délai HTTP est plus long que
     * l'attente, pour ne jamais couper une réponse normale.
     */
    getChanges(datetime, wait) {
        return this.#json({ action: "changes", datetime, wait }, undefined, (wait + 20) * 1000);
    }

    async exec(cmdId, options = {}) {
        const text = await this.#request({ action: "exec" }, { cmd_id: cmdId, options }, 15_000);
        if (text.trim() !== "OK") {
            throw new Error(text.trim().slice(0, 200));
        }
    }

    async sendStatus(status) {
        try {
            await this.#request({ action: "status" }, status, 15_000);
        } catch (error) {
            log.warning("Envoi de l'état à Jeedom impossible :", error);
        }
    }
}
