<?php
/* This file is part of Jeedom.
 *
 * Jeedom is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Jeedom is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Jeedom. If not, see <http://www.gnu.org/licenses/>.
 */

require_once __DIR__ . '/../../../core/php/core.inc.php';

function matterhubbe_install() {
    /* Le callback du démon ne parle qu'à un processus local. */
    config::save('api::matterhubbe::mode', 'localhost', 'core');
    matterhubbe_createDefaultBridge();
}

/*
 * Un pont prêt à l'emploi dès l'installation : il ne reste qu'à cocher les
 * équipements et scanner le QR code. Un seul suffit pour Google Home.
 */
function matterhubbe_createDefaultBridge() {
    try {
        if (count(matterhubbe::byType('matterhubbe')) > 0) {
            return;
        }
        $bridge = new matterhubbe();
        $bridge->setName('Jeedom');
        $bridge->setEqType_name('matterhubbe');
        $bridge->setIsEnable(1);
        $bridge->setIsVisible(0);
        $bridge->save();
    } catch (Throwable $e) {
        log::add('matterhubbe', 'error', __('Création du pont par défaut :', __FILE__) . ' ' . $e->getMessage());
    }
}

/* Appelée à chaque mise à jour, dans la requête HTTP : rien de lent ici. */
function matterhubbe_update() {
    try {
        config::save('api::matterhubbe::mode', 'localhost', 'core');
        foreach (matterhubbe::byType('matterhubbe') as $bridge) {
            $bridge->createCommands();
        }
    } catch (Throwable $e) {
        log::add('matterhubbe', 'error', __('Mise à jour du plugin :', __FILE__) . ' ' . $e->getMessage());
    }
}

/*
 * Appelée aussi à la simple désactivation du plugin : on arrête le démon, mais
 * on ne détruit rien, et surtout pas data/matter (l'appairage Google).
 */
function matterhubbe_remove() {
    try {
        matterhubbe::deamon_stop();
    } catch (Throwable $e) {
        log::add('matterhubbe', 'error', __('Arrêt du démon :', __FILE__) . ' ' . $e->getMessage());
    }
}
