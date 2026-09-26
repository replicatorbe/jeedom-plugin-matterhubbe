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

/*
 * Point d'entrée du démon. Toutes les routes sont protégées par la clé API du
 * plugin, dont l'API est en mode « localhost » (posé à l'installation).
 *
 *   GET  ?action=config                      configuration + valeurs, en JSON
 *   GET  ?action=changes&datetime=…&wait=25  attente longue sur event::changes
 *   POST ?action=exec    {cmd_id, options}   commande demandée par Google
 *   POST ?action=status  {bridges:[…]}       codes d'appairage, contrôleurs
 */

require_once __DIR__ . '/../../../../core/php/core.inc.php';

/* 401 et non 200 sur refus : le démon ne dispose que de la réponse pour savoir s'il a été entendu. */
if (!jeedom::apiAccess(init('apikey'), 'matterhubbe')) {
    http_response_code(401);
    echo 'Not authorized';
    die();
}

try {
    switch (init('action')) {
        case 'config':
            header('Content-Type: application/json');
            echo json_encode(matterhubbe::getDaemonConfig(), JSON_INVALID_UTF8_SUBSTITUTE);
            die();

        case 'changes':
            /* L'attente dure au plus 30 s ; on laisse de la marge au reste. */
            set_time_limit(90);
            /* La session n'est pas utilisée : ne pas la garder verrouillée pendant l'attente. */
            if (session_status() == PHP_SESSION_ACTIVE) {
                session_write_close();
            }
            header('Content-Type: application/json');
            echo json_encode(matterhubbe::getChanges(init('datetime'), init('wait', 25)), JSON_INVALID_UTF8_SUBSTITUTE);
            die();

        case 'exec':
            $payload = json_decode(file_get_contents('php://input'), true);
            if (!is_array($payload) || !isset($payload['cmd_id'])) {
                throw new Exception(__('Demande illisible', __FILE__));
            }
            matterhubbe::execFromDaemon($payload['cmd_id'], isset($payload['options']) ? $payload['options'] : array());
            echo 'OK';
            die();

        case 'status':
            $payload = json_decode(file_get_contents('php://input'), true);
            if (is_array($payload)) {
                matterhubbe::updateStatus($payload);
            }
            echo 'OK';
            die();
    }
    http_response_code(400);
    echo 'Action inconnue';
} catch (Throwable $e) {
    log::add('matterhubbe', 'error', $e->getMessage());
    /* 200 avec le message : le démon l'affiche tel quel dans son journal. */
    echo $e->getMessage();
}
