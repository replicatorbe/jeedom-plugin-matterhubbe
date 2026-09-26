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

require_once __DIR__ . '/../../../../core/php/core.inc.php';

/*
 * Un équipement matterhubbe est un pont Matter : un code d'appairage, un port,
 * et la liste des équipements Jeedom qu'il expose à Google Home.
 *
 * Le PHP choisit, d'après les types génériques des commandes, quel appareil
 * Matter chaque équipement devient et quelles commandes jouent chaque rôle.
 * Le démon Node (resources/matterhubbed) ne connaît que Matter.
 */
class matterhubbe extends eqLogic {

    /* Filtre de event::changes : le démon ne suit que les mises à jour de valeurs. */
    public static $_listenEvents = array('cmd::update');

    /* Un seul rechargement du démon par requête HTTP. */
    private static $_reloadScheduled = false;

    const DEFAULT_PORT = 5540;
    const DEFAULT_SOCKET_PORT = 55064;

    /* ========================================================== CATALOGUE */

    /*
     * Familles d'appareils, dans l'ordre où on les cherche sur un équipement.
     * Une famille « switch » peut donner plusieurs types Matter, au choix de
     * l'utilisateur ; les autres n'en donnent qu'un.
     */
    public static function families() {
        return array(
            'light' => array(
                'label' => __('Lumière', __FILE__),
                'kinds' => array('dimmable_light', 'onoff_light'),
            ),
            'energy' => array(
                'label' => __('Prise / relais', __FILE__),
                'kinds' => array('plug', 'onoff_light'),
            ),
            'contact' => array(
                'label' => __('Ouverture', __FILE__),
                'kinds' => array('contact'),
            ),
            'occupancy' => array(
                'label' => __('Présence', __FILE__),
                'kinds' => array('occupancy'),
            ),
            'temperature' => array(
                'label' => __('Température', __FILE__),
                'kinds' => array('temperature'),
            ),
            'humidity' => array(
                'label' => __('Humidité', __FILE__),
                'kinds' => array('humidity'),
            ),
        );
    }

    public static function kindLabels() {
        return array(
            'dimmable_light' => __('Lumière variable', __FILE__),
            'onoff_light'    => __('Lumière', __FILE__),
            'plug'           => __('Prise', __FILE__),
            'contact'        => __('Capteur d\'ouverture', __FILE__),
            'occupancy'      => __('Capteur de présence', __FILE__),
            'temperature'    => __('Capteur de température', __FILE__),
            'humidity'       => __('Capteur d\'humidité', __FILE__),
        );
    }

    /* Première commande de l'équipement portant l'un de ces types génériques, dans l'ordre donné. */
    private static function findCmd($_cmds, $_types, $_type = null, $_subType = null) {
        foreach ((array) $_types as $generic) {
            foreach ($_cmds as $cmd) {
                if ($cmd->getGeneric_type() != $generic) {
                    continue;
                }
                if (($_type === null || $cmd->getType() == $_type) && ($_subType === null || $cmd->getSubType() == $_subType)) {
                    return $cmd;
                }
            }
        }
        return null;
    }

    /*
     * Action d'un type générique, de préférence celle qui est liée à l'info
     * donnée (« Valeur de retour d'état »). Sur un module à plusieurs relais,
     * c'est ce qui évite d'allumer le relais 2 en lisant l'état du relais 1.
     */
    private static function findLinkedAction($_cmds, $_types, $_info) {
        if (is_object($_info)) {
            foreach ((array) $_types as $generic) {
                foreach ($_cmds as $cmd) {
                    if ($cmd->getType() == 'action' && $cmd->getGeneric_type() == $generic && $cmd->getValue() == $_info->getId()) {
                        return $cmd;
                    }
                }
            }
        }
        return self::findCmd($_cmds, $_types, 'action');
    }

    private static function cmdId($_cmd) {
        return is_object($_cmd) ? (int) $_cmd->getId() : null;
    }

    /*
     * Ce qu'un équipement peut devenir, famille par famille : les commandes de
     * chaque rôle, les paramètres et le type proposé par défaut. Rien si
     * l'équipement n'a aucun type générique exploitable.
     *
     * Rôles : state (allumé si > 0), level (luminosité dans l'échelle du
     * curseur), on, off, setLevel, value (capteurs).
     */
    public static function analyzeEquipment($_eqLogic) {
        $cmds = $_eqLogic->getCmd();
        $out = array();

        /* Lumière. L'état binaire est préféré ; un LIGHT_STATE numérique sert
         * alors de luminosité s'il n'y a pas de LIGHT_BRIGHTNESS. */
        $stateBinary = self::findCmd($cmds, array('LIGHT_STATE_BOOL', 'LIGHT_STATE'), 'info', 'binary');
        $stateNumeric = self::findCmd($cmds, 'LIGHT_STATE', 'info', 'numeric');
        $state = is_object($stateBinary) ? $stateBinary : $stateNumeric;
        $level = self::findCmd($cmds, 'LIGHT_BRIGHTNESS', 'info');
        if (!is_object($level)) {
            $level = $stateNumeric;
        }
        $on = self::findLinkedAction($cmds, 'LIGHT_ON', $state);
        $off = self::findLinkedAction($cmds, 'LIGHT_OFF', $state);
        $slider = self::findLinkedAction($cmds, 'LIGHT_SLIDER', is_object($level) ? $level : $state);
        if (is_object($slider) || (is_object($on) && is_object($off))) {
            $params = array();
            if (is_object($slider)) {
                $params['levelMin'] = is_numeric($slider->getConfiguration('minValue')) ? (float) $slider->getConfiguration('minValue') : 0;
                $params['levelMax'] = is_numeric($slider->getConfiguration('maxValue')) ? (float) $slider->getConfiguration('maxValue') : 100;
            }
            $out['light'] = array(
                'default' => is_object($slider) ? 'dimmable_light' : 'onoff_light',
                'kinds' => is_object($slider) ? array('dimmable_light', 'onoff_light') : array('onoff_light'),
                'cmds' => array(
                    'state' => self::cmdId($state),
                    'level' => self::cmdId($level),
                    'on' => self::cmdId($on),
                    'off' => self::cmdId($off),
                    'setLevel' => self::cmdId($slider),
                ),
                'params' => $params,
            );
        }

        /* Prise ou relais. */
        $state = self::findCmd($cmds, 'ENERGY_STATE', 'info');
        $on = self::findLinkedAction($cmds, 'ENERGY_ON', $state);
        $off = self::findLinkedAction($cmds, 'ENERGY_OFF', $state);
        if (is_object($on) && is_object($off)) {
            $out['energy'] = array(
                'default' => 'plug',
                'kinds' => array('plug', 'onoff_light'),
                'cmds' => array('state' => self::cmdId($state), 'on' => self::cmdId($on), 'off' => self::cmdId($off)),
                'params' => array(),
            );
        }

        /* Capteurs : une seule info suffit. */
        $sensors = array(
            'contact' => array('OPENING', 'OPENING_WINDOW'),
            'occupancy' => array('PRESENCE'),
            'temperature' => array('TEMPERATURE'),
            'humidity' => array('HUMIDITY'),
        );
        foreach ($sensors as $family => $types) {
            $cmd = self::findCmd($cmds, $types, 'info');
            if (!is_object($cmd)) {
                continue;
            }
            $params = array();
            if ($family == 'contact') {
                /* Jeedom compte 1 = fermé ; un plugin qui remonte l'inverse le signale par « Inverser ». */
                $params['invert'] = $cmd->getDisplay('invertBinary') == 1;
            }
            $out[$family] = array(
                'default' => $family,
                'kinds' => array($family),
                'cmds' => array('value' => self::cmdId($cmd)),
                'params' => $params,
            );
        }
        return $out;
    }

    /*
     * Tous les équipements Jeedom qui peuvent être exposés, pour la page du
     * plugin. Les ponts eux-mêmes en sont exclus.
     */
    public static function candidates() {
        $families = self::families();
        $order = array_flip(array_keys($families));
        $labels = self::kindLabels();
        $out = array();
        foreach (eqLogic::all() as $eqLogic) {
            if ($eqLogic->getEqType_name() == __CLASS__) {
                continue;
            }
            $analysis = self::analyzeEquipment($eqLogic);
            if (count($analysis) == 0) {
                continue;
            }
            $object = $eqLogic->getObject();
            foreach ($analysis as $family => $info) {
                $kinds = array();
                foreach ($info['kinds'] as $kind) {
                    $kinds[] = array('kind' => $kind, 'label' => $labels[$kind]);
                }
                $out[] = array(
                    'eq_id' => (int) $eqLogic->getId(),
                    'family' => $family,
                    'familyLabel' => $families[$family]['label'],
                    'familyOrder' => $order[$family],
                    'name' => $eqLogic->getName(),
                    'humanName' => $eqLogic->getHumanName(),
                    'object' => is_object($object) ? $object->getName() : '',
                    'plugin' => $eqLogic->getEqType_name(),
                    'isEnable' => (int) $eqLogic->getIsEnable(),
                    'default' => $info['default'],
                    'kinds' => $kinds,
                );
            }
        }
        usort($out, function ($a, $b) {
            $cmp = strcasecmp($a['object'], $b['object']);
            if ($cmp == 0) {
                $cmp = strcasecmp($a['name'], $b['name']);
            }
            return $cmp != 0 ? $cmp : $a['familyOrder'] - $b['familyOrder'];
        });
        return $out;
    }

    /* Sélection enregistrée sur le pont : [{eq_id, family, kind, name}, …]. */
    public function getSelection() {
        $selection = $this->getConfiguration('devices', array());
        if (is_string($selection)) {
            $selection = json_decode($selection, true);
        }
        return is_array($selection) ? $selection : array();
    }

    /*
     * Appareils Matter du pont, prêts pour le démon.
     *
     * L'identifiant d'endpoint (eq<id>-<type>) ne dépend ni du nom ni de
     * l'ordre : Google garde l'appareil, sa pièce et ses routines tant que
     * l'équipement et son type ne changent pas. Un équipement désactivé reste
     * exposé mais « injoignable » : le retirer ferait perdre sa pièce.
     */
    public function buildDevices() {
        $families = self::families();
        $order = array_flip(array_keys($families));
        $labels = self::kindLabels();
        $selection = $this->getSelection();

        /* Familles choisies par équipement, pour décider des suffixes de nom. */
        $chosen = array();
        foreach ($selection as $item) {
            if (isset($item['eq_id'], $item['family'], $order[$item['family']])) {
                $chosen[(int) $item['eq_id']][] = $order[$item['family']];
            }
        }

        $devices = array();
        $keys = array();
        $analyses = array();
        foreach ($selection as $item) {
            $eqId = isset($item['eq_id']) ? (int) $item['eq_id'] : 0;
            $family = isset($item['family']) ? $item['family'] : '';
            $eqLogic = eqLogic::byId($eqId);
            if (!is_object($eqLogic) || !isset($families[$family])) {
                continue;
            }
            if (!isset($analyses[$eqId])) {
                $analyses[$eqId] = self::analyzeEquipment($eqLogic);
            }
            if (!isset($analyses[$eqId][$family])) {
                log::add(__CLASS__, 'warning', $eqLogic->getHumanName() . ' : ' . __('plus aucune commande de type', __FILE__)
                       . ' « ' . $families[$family]['label'] . ' », ' . __('appareil ignoré', __FILE__));
                continue;
            }
            $info = $analyses[$eqId][$family];
            $kind = (isset($item['kind']) && in_array($item['kind'], $info['kinds'])) ? $item['kind'] : $info['default'];

            $name = isset($item['name']) ? trim($item['name']) : '';
            if ($name == '') {
                $name = self::defaultName($eqLogic->getName(), $families[$family]['label'], $order[$family], $chosen[$eqId]);
            }

            /* Deux familles du même équipement exposées sous le même type : la seconde prend la famille dans sa clé. */
            $key = 'eq' . $eqId . '-' . $kind;
            if (isset($keys[$key])) {
                $key .= '-' . $family;
            }
            $keys[$key] = true;

            $devices[] = array(
                'key' => $key,
                'kind' => $kind,
                'name' => $name,
                'productName' => $labels[$kind],
                'eq_id' => $eqId,
                'reachable' => (bool) $eqLogic->getIsEnable(),
                'cmds' => array_filter($info['cmds'], function ($id) {
                    return $id !== null;
                }),
                'params' => (object) $info['params'],
            );
        }
        return $devices;
    }

    /*
     * Nom par défaut : celui de l'équipement, suivi de la fonction quand une
     * autre fonction du même équipement, venant avant dans l'ordre des
     * familles, est aussi exposée (« ESP bureau » puis « ESP bureau humidité »).
     * La page du plugin applique la même règle pour son aperçu.
     */
    public static function defaultName($_eqName, $_familyLabel, $_familyOrder, $_chosenOrders) {
        foreach ((array) $_chosenOrders as $other) {
            if ($other < $_familyOrder) {
                return $_eqName . ' ' . mb_strtolower($_familyLabel);
            }
        }
        return $_eqName;
    }

    /*
     * Ponts actifs et leurs appareils, et les commandes en jeu : les infos que
     * le démon suit, les actions qu'il a le droit d'exécuter.
     */
    private static function computeExposure() {
        $bridges = array();
        $infoIds = array();
        $actionIds = array();
        foreach (self::byType(__CLASS__, true) as $bridge) {
            $devices = $bridge->buildDevices();
            foreach ($devices as $device) {
                foreach ($device['cmds'] as $role => $cmdId) {
                    if (in_array($role, array('on', 'off', 'setLevel'))) {
                        $actionIds[$cmdId] = true;
                    } else {
                        $infoIds[$cmdId] = true;
                    }
                }
            }
            $bridges[] = array(
                'id' => (int) $bridge->getId(),
                'name' => $bridge->getName(),
                'port' => (int) $bridge->getConfiguration('port', self::DEFAULT_PORT),
                'devices' => $devices,
            );
        }
        return array(
            'bridges' => $bridges,
            'infoIds' => array_map('intval', array_keys($infoIds)),
            'actionIds' => array_map('intval', array_keys($actionIds)),
        );
    }

    /*
     * Listes lues par event::changes (filtre) et par execFromDaemon. Une liste
     * vide laisserait passer tous les événements : on y met un identifiant
     * impossible.
     */
    private static function storeExposure($_exposure) {
        cache::set(__CLASS__ . '::event', count($_exposure['infoIds']) > 0 ? $_exposure['infoIds'] : array(-1));
        cache::set(__CLASS__ . '::allowedCmds', $_exposure['actionIds']);
        cache::set(__CLASS__ . '::fingerprint', md5(json_encode($_exposure['bridges'])));
    }

    /* Après « Vider le cache » de Jeedom, les listes sont reconstruites à la première demande. */
    private static function ensureExposure() {
        if (!cache::exist(__CLASS__ . '::allowedCmds') || !cache::exist(__CLASS__ . '::event')) {
            self::storeExposure(self::computeExposure());
        }
    }

    /*
     * Configuration complète du démon. Le curseur d'événements est pris AVANT
     * de lire les valeurs : un changement survenu entre les deux sera rejoué,
     * jamais perdu.
     */
    public static function getDaemonConfig() {
        $datetime = getmicrotime();
        $exposure = self::computeExposure();
        self::storeExposure($exposure);

        $values = array();
        foreach ($exposure['infoIds'] as $cmdId) {
            $cmd = cmd::byId($cmdId);
            if (is_object($cmd)) {
                $values[(string) $cmdId] = $cmd->execCmd();
            }
        }
        return array('datetime' => $datetime, 'bridges' => $exposure['bridges'], 'values' => (object) $values);
    }

    /*
     * Attente longue pour le démon : les nouvelles valeurs des infos suivies.
     *
     * Curseur rendu : juste après le dernier événement lu. event::changes
     * compare en « >= » : rendre la date du dernier événement le rejouerait
     * sans fin. Le pas est d'un dix-millième de seconde et pas moins : les
     * dates ont quatre décimales, et PDO passe le curseur en chaîne à 14
     * chiffres significatifs, ce qui effacerait un pas plus fin. Sans
     * événement, on recule d'une seconde : un événement horodaté avant la
     * lecture mais écrit juste après serait perdu sinon.
     */
    public static function getChanges($_datetime, $_wait) {
        self::ensureExposure();
        $wait = max(1, min(30, (int) $_wait));
        $since = is_numeric($_datetime) ? (float) $_datetime : getmicrotime();
        $changes = event::changes($since, $wait, __CLASS__);
        $events = array();
        $last = null;
        foreach ($changes['result'] as $event) {
            if (isset($event['datetime']) && is_numeric($event['datetime'])) {
                $last = max((float) $last, (float) $event['datetime']);
            }
            if (!isset($event['option']['cmd_id'])) {
                continue;
            }
            $events[] = array('cmd_id' => (int) $event['option']['cmd_id'], 'value' => $event['option']['value']);
        }
        $cursor = ($last !== null) ? $last + 0.0001 : max($since, (float) $changes['datetime'] - 1);
        return array('datetime' => $cursor, 'events' => $events);
    }

    /* Commande demandée par Google, relayée par le démon. */
    public static function execFromDaemon($_cmdId, $_options) {
        self::ensureExposure();
        $allowed = cache::byKey(__CLASS__ . '::allowedCmds')->getValue(array());
        if (!in_array((int) $_cmdId, (array) $allowed)) {
            throw new Exception(__('Commande non exposée :', __FILE__) . ' ' . $_cmdId);
        }
        $cmd = cmd::byId($_cmdId);
        if (!is_object($cmd) || $cmd->getType() != 'action') {
            throw new Exception(__('Commande introuvable :', __FILE__) . ' ' . $_cmdId);
        }
        $options = array();
        if (is_array($_options) && isset($_options['slider']) && is_numeric($_options['slider'])) {
            $options['slider'] = $_options['slider'];
        }
        log::add(__CLASS__, 'debug', __('Google Home :', __FILE__) . ' ' . $cmd->getHumanName() . ' ' . json_encode($options));
        $cmd->execCmd($options);
    }

    /* Rechargement du démon si la configuration qu'il a reçue n'est plus la bonne. */
    public static function reloadIfExposureChanged() {
        $exposure = self::computeExposure();
        $fingerprint = md5(json_encode($exposure['bridges']));
        if ($fingerprint === cache::byKey(__CLASS__ . '::fingerprint')->getValue('')) {
            return false;
        }
        log::add(__CLASS__, 'info', __('Équipements exposés modifiés : rechargement du démon', __FILE__));
        self::storeExposure($exposure);
        self::sendToDaemon(array('order' => 'reload'));
        return true;
    }

    /* État des ponts envoyé par le démon : codes d'appairage, contrôleurs. */
    public static function updateStatus($_status) {
        if (!isset($_status['bridges']) || !is_array($_status['bridges'])) {
            return;
        }
        foreach ($_status['bridges'] as $status) {
            /* Un pont qui n'a pas démarré n'a ni code ni contrôleurs à jour : on garde le dernier état connu. */
            if (!is_array($status) || empty($status['running'])) {
                continue;
            }
            $bridge = self::byId(isset($status['id']) ? $status['id'] : 0);
            if (!is_object($bridge) || $bridge->getEqType_name() != __CLASS__) {
                continue;
            }
            $fabrics = (isset($status['fabrics']) && is_array($status['fabrics'])) ? $status['fabrics'] : array();
            $status['fabrics'] = $fabrics;
            $status['updated'] = date('Y-m-d H:i:s');
            $bridge->setCache('matter_status', $status);
            $bridge->checkAndUpdateCmd('commissioned', !empty($status['commissioned']) ? 1 : 0);
            $bridge->checkAndUpdateCmd('controllers', count($fabrics));
            $bridge->checkAndUpdateCmd('devices', isset($status['devices']) ? (int) $status['devices'] : 0);
        }
    }

    /* ========================================================== DÉMON */

    /*
     * L'état du processus se détermine indépendamment de « launchable » : si
     * l'absence de pont rendait aussi l'état « nok », le cœur croirait le démon
     * arrêté et ne l'arrêterait jamais.
     */
    public static function deamon_info() {
        $return = array('log' => __CLASS__ . 'd', 'state' => 'nok', 'launchable' => 'nok');

        $pid_file = jeedom::getTmpFolder(__CLASS__) . '/deamon.pid';
        if (file_exists($pid_file)) {
            $pid = trim(file_get_contents($pid_file));
            if ($pid != '' && @posix_getsid((int) $pid)) {
                $return['state'] = 'ok';
            } else {
                @unlink($pid_file);
            }
        }

        $node = self::nodeVersionProblem();
        if ($node != '') {
            $return['launchable_message'] = $node;
        } elseif (count(self::byType(__CLASS__, true)) > 0) {
            $return['launchable'] = 'ok';
        } else {
            $return['launchable_message'] = __('Aucun pont actif : créez-en un depuis la page du plugin.', __FILE__);
        }
        return $return;
    }

    /*
     * matter.js exige Node 20.19 ou plus (20.19+ ou 22.13+). Le contrôle des
     * dépendances du cœur ne regarde que `npm ls` : sans ce test, un Node trop
     * ancien donnerait des dépendances « OK » et un démon qui meurt sans rien
     * dire. Résultat gardé dix minutes, deamon_info étant appelé souvent.
     */
    /*
     * Appelé par le cœur après le contrôle des paquets : un Node.js trop
     * ancien rend les dépendances « NOK », et Jeedom les réinstalle de lui-même
     * (resources/install_node.sh met alors Node.js 22 en place).
     */
    public static function additionnalDependancyCheck() {
        cache::delete(__CLASS__ . '::nodeVersion');
        return array('state' => self::nodeVersionProblem() == '' ? 'ok' : 'nok');
    }

    public static function nodeVersionProblem() {
        $cache = cache::byKey(__CLASS__ . '::nodeVersion');
        $version = $cache->getValue(null);
        if ($version === null) {
            $version = trim((string) shell_exec('node -v 2>/dev/null'));
            cache::set(__CLASS__ . '::nodeVersion', $version, 600);
        }
        if ($version == '') {
            return __('Node.js est absent : installez les dépendances du plugin.', __FILE__);
        }
        $v = ltrim($version, 'v');
        $ok = (version_compare($v, '20.19.0', '>=') && version_compare($v, '22.0.0', '<')) || version_compare($v, '22.13.0', '>=');
        if (!$ok) {
            return __('Node.js', __FILE__) . ' ' . $version . ' ' . __('est trop ancien : il faut la version 20.19 ou plus. Relancez l\'installation des dépendances.', __FILE__);
        }
        return '';
    }

    public static function deamon_start() {
        self::deamon_stop();

        $info = self::deamon_info();
        if ($info['launchable'] != 'ok') {
            throw new Exception(__('Le démon ne peut pas être lancé :', __FILE__) . ' ' . $info['launchable_message']);
        }

        $daemon = realpath(__DIR__ . '/../../resources/matterhubbed/matterhubbed.js');
        $cmd  = 'node ' . escapeshellarg($daemon);
        $cmd .= ' --callback '   . escapeshellarg(self::getCallbackUrl());
        $cmd .= ' --pid '        . escapeshellarg(jeedom::getTmpFolder(__CLASS__) . '/deamon.pid');
        $cmd .= ' --socketport ' . escapeshellarg(self::socketPort());
        $cmd .= ' --loglevel '   . escapeshellarg(log::convertLogLevel(log::getLogLevel(__CLASS__)));
        $cmd .= ' --datadir '    . escapeshellarg(self::getDataDir());
        $interface = trim(config::byKey('mdnsInterface', __CLASS__, ''));
        if ($interface != '') {
            $cmd .= ' --mdns-interface ' . escapeshellarg($interface);
        }

        /* La clé API passe par l'entrée standard et jamais par la ligne de
         * commande : ps est lisible par n'importe quel utilisateur local. */
        $full = 'echo ' . escapeshellarg(jeedom::getApiKey(__CLASS__)) . ' | ' . $cmd
              . ' >> ' . log::getPathToLog(__CLASS__ . 'd') . ' 2>&1 &';

        log::add(__CLASS__, 'info', __('Lancement du démon', __FILE__));
        exec($full);

        for ($i = 1; $i <= 30; $i++) {
            $info = self::deamon_info();
            if ($info['state'] == 'ok') {
                message::removeAll(__CLASS__, 'unableStartDeamon');
                return true;
            }
            sleep(1);
        }

        log::add(__CLASS__, 'error', __('Le démon n\'a pas démarré. Consultez le journal', __FILE__) . ' ' . __CLASS__ . 'd.');
        message::add(__CLASS__, __('Le démon n\'a pas démarré. Consultez le journal', __FILE__) . ' ' . __CLASS__ . 'd.', null, 'unableStartDeamon');
        return false;
    }

    /*
     * Arrêt propre : SIGTERM, puis jusqu'à dix secondes pour que le démon ferme
     * ses ponts et finisse d'écrire son stockage Matter. Un kill -9 immédiat
     * pourrait laisser l'appairage Google à moitié écrit.
     */
    public static function deamon_stop() {
        $pid_file = jeedom::getTmpFolder(__CLASS__) . '/deamon.pid';
        if (file_exists($pid_file)) {
            $pid = (int) trim(file_get_contents($pid_file));
            if ($pid > 0 && self::isDaemonPid($pid)) {
                posix_kill($pid, 15);
                for ($i = 0; $i < 40 && self::isDaemonPid($pid); $i++) {
                    usleep(250000);
                }
                if (self::isDaemonPid($pid)) {
                    posix_kill($pid, 9);
                }
            }
            @unlink($pid_file);
        }
        /* Filets de sécurité : un démon lancé à la main, ou dont le fichier de PID
         * a été perdu, garderait le port d'ordres et le port Matter occupés. */
        if (count(system::ps('resources/matterhubbed/matterhubbed.js')) > 0) {
            system::kill('resources/matterhubbed/matterhubbed.js');
        }
        system::fuserk((string) self::socketPort());
        return true;
    }

    /* Le PID est-il toujours notre démon ? Après un kill -9, il a pu être réattribué à un autre processus. */
    private static function isDaemonPid($_pid) {
        $cmdline = @file_get_contents('/proc/' . (int) $_pid . '/cmdline');
        return $cmdline !== false && strpos($cmdline, 'matterhubbed.js') !== false;
    }

    public static function socketPort() {
        $port = (int) config::byKey('socketport', __CLASS__, self::DEFAULT_SOCKET_PORT);
        return ($port >= 1024 && $port <= 65535) ? $port : self::DEFAULT_SOCKET_PORT;
    }

    public static function getCallbackUrl() {
        return network::getNetworkAccess('internal', 'http:127.0.0.1:port:comp') . '/plugins/matterhubbe/core/php/jeeMatterhubbe.php';
    }

    /*
     * Identité Matter des ponts : fabrics, clés, code d'appairage, numéros
     * d'endpoint. La perdre oblige à réappairer Google et à refaire les pièces.
     * Elle est dans data/, sauvegardé par Jeedom et jamais écrasé par un déploiement.
     */
    public static function getDataDir() {
        $dir = __DIR__ . '/../../data/matter';
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        return realpath($dir) ?: $dir;
    }

    public static function sendToDaemon($_payload, $_waitAnswer = false, $_timeout = 5) {
        if (self::deamon_info()['state'] != 'ok') {
            return false;
        }
        $port = self::socketPort();
        $socket = @stream_socket_client('tcp://127.0.0.1:' . $port, $errno, $errstr, 2);
        if (!$socket) {
            log::add(__CLASS__, 'debug', __('Le démon n\'a pas accepté la connexion :', __FILE__) . ' ' . $errstr);
            return false;
        }
        $_payload['apikey'] = jeedom::getApiKey(__CLASS__);
        fwrite($socket, json_encode($_payload) . "\n");
        $answer = null;
        if ($_waitAnswer) {
            stream_set_timeout($socket, $_timeout);
            $answer = json_decode(trim((string) fgets($socket, 1048576)), true);
        }
        fclose($socket);
        return $_waitAnswer ? $answer : true;
    }

    /* Une seule notification par requête HTTP, une fois l'équipement en base. */
    public static function reloadDaemonConfig() {
        if (self::$_reloadScheduled) {
            return;
        }
        self::$_reloadScheduled = true;
        register_shutdown_function(function () {
            try {
                if (matterhubbe::deamon_info()['state'] == 'ok') {
                    matterhubbe::sendToDaemon(array('order' => 'reload'));
                } else {
                    matterhubbe::startDaemonIfAllowed();
                }
            } catch (Throwable $e) {
                log::add('matterhubbe', 'error', __('Rechargement du démon :', __FILE__) . ' ' . $e->getMessage());
            }
        });
    }

    /*
     * Le cœur ne vérifie les démons que toutes les cinq minutes : sans ce
     * démarrage, le premier pont créé resterait sans code d'appairage jusque-là.
     */
    public static function startDaemonIfAllowed() {
        $info = self::deamon_info();
        if ($info['state'] == 'ok' || $info['launchable'] != 'ok') {
            return;
        }
        /* Par le cœur : il respecte la gestion automatique, les dépendances et
         * son verrou entre deux lancements, que checkDeamon partage. */
        $plugin = plugin::byId(__CLASS__);
        if (is_object($plugin)) {
            $plugin->deamon_start(false, true);
        }
    }

    /*
     * Un équipement exposé désactivé, dont les types génériques ou les
     * commandes changent : le démon n'en sait rien. Toutes les cinq minutes,
     * on compare ce qu'il a reçu à ce qu'il devrait avoir.
     */
    public static function cron5() {
        if (self::deamon_info()['state'] != 'ok') {
            return;
        }
        try {
            self::reloadIfExposureChanged();
        } catch (Throwable $e) {
            log::add(__CLASS__, 'error', __('Contrôle des équipements exposés :', __FILE__) . ' ' . $e->getMessage());
        }
    }

    /* Port des ordres : un entier entre 1024 et 65535, rien d'autre (il finit dans une commande sudo). */
    public static function preConfig_socketport($_value) {
        $port = (int) $_value;
        return ($port >= 1024 && $port <= 65535) ? $port : self::DEFAULT_SOCKET_PORT;
    }

    public static function postConfig_socketport($_value) {
        if (self::deamon_info()['state'] == 'ok') {
            message::add(__CLASS__, __('Le port des ordres a changé : redémarrez le démon pour qu\'il soit pris en compte.', __FILE__), null, 'socketportChanged');
        }
    }

    public static function postConfig_mdnsInterface($_value) {
        if (self::deamon_info()['state'] == 'ok') {
            message::add(__CLASS__, __('L\'interface réseau a changé : redémarrez le démon pour qu\'elle soit prise en compte.', __FILE__), null, 'mdnsInterfaceChanged');
        }
    }

    /* ========================================================== ÉQUIPEMENT */

    /*
     * Jamais d'exception ici à la création : le cœur crée l'équipement avec son
     * seul nom. Le port proposé est le premier libre parmi les ponts.
     */
    public function preSave() {
        $used = array(self::socketPort());
        foreach (self::byType(__CLASS__) as $other) {
            if ($other->getId() != $this->getId()) {
                $used[] = (int) $other->getConfiguration('port', self::DEFAULT_PORT);
            }
        }
        $port = (int) $this->getConfiguration('port', 0);
        /* Port absent, réservé au système ou déjà pris (pont dupliqué) : le premier libre à partir de 5540. */
        if ($port < 1024 || $port > 65535 || in_array($port, $used)) {
            $wanted = $port;
            $port = self::DEFAULT_PORT;
            while (in_array($port, $used)) {
                $port++;
            }
            if ($wanted > 0 && $this->getId() != '') {
                log::add(__CLASS__, 'warning', $this->getHumanName() . ' : ' . __('port', __FILE__) . ' ' . $wanted . ' '
                       . __('indisponible, remplacé par', __FILE__) . ' ' . $port);
            }
            $this->setConfiguration('port', $port);
        }
    }

    public function postSave() {
        $this->createCommands();
        self::reloadDaemonConfig();
    }

    public function postRemove() {
        self::reloadDaemonConfig();
    }

    private function addInfoCmd($_logicalId, $_name, $_subType, $_order) {
        $cmd = $this->getCmd(null, $_logicalId);
        if (is_object($cmd)) {
            return;
        }
        $cmd = new matterhubbeCmd();
        $cmd->setEqLogic_id($this->getId());
        $cmd->setLogicalId($_logicalId);
        $cmd->setName($_name);
        $cmd->setType('info');
        $cmd->setSubType($_subType);
        $cmd->setIsVisible(1);
        $cmd->setOrder($_order);
        $cmd->save();
    }

    public function createCommands() {
        $this->addInfoCmd('commissioned', __('Appairé', __FILE__), 'binary', 1);
        $this->addInfoCmd('controllers', __('Contrôleurs', __FILE__), 'numeric', 2);
        $this->addInfoCmd('devices', __('Appareils exposés', __FILE__), 'numeric', 3);
    }

    /*
     * État du pont pour la page : celui du démon s'il répond, sinon le dernier
     * reçu, avec ce qu'il faut pour expliquer pourquoi il n'y a pas de code.
     */
    public function getMatterStatus() {
        $info = self::deamon_info();
        $inDaemon = false;
        $error = '';
        if ($info['state'] == 'ok') {
            $answer = self::sendToDaemon(array('order' => 'status'), true);
            if (is_array($answer) && isset($answer['result']) && is_array($answer['result'])) {
                self::updateStatus(array('bridges' => $answer['result']));
                foreach ($answer['result'] as $bridge) {
                    if (isset($bridge['id']) && $bridge['id'] == $this->getId()) {
                        $inDaemon = !empty($bridge['running']);
                        $error = isset($bridge['error']) ? (string) $bridge['error'] : '';
                    }
                }
            }
        }
        $status = $inDaemon ? $this->getCache('matter_status', array()) : array();
        $plugin = plugin::byId(__CLASS__);
        $status['id'] = (int) $this->getId();
        $status['enabled'] = (int) $this->getIsEnable();
        $status['daemon'] = $info['state'];
        $status['inDaemon'] = $inDaemon;
        $status['launchable'] = $info['launchable'];
        $status['launchableMessage'] = isset($info['launchable_message']) ? $info['launchable_message'] : '';
        $status['dependancy'] = is_object($plugin) ? $plugin->dependancy_info()['state'] : 'nok';
        $status['error'] = $error;
        $status['selected'] = count($this->getSelection());
        return $status;
    }

    public static function health() {
        $info = self::deamon_info();
        $return = array();
        foreach (self::byType(__CLASS__, true) as $bridge) {
            $status = $bridge->getCache('matter_status', array());
            $fabrics = (isset($status['fabrics']) && is_array($status['fabrics'])) ? $status['fabrics'] : array();
            $paired = !empty($status['commissioned']);
            $return[] = array(
                'test' => __('Pont', __FILE__) . ' ' . $bridge->getName(),
                'result' => $info['state'] != 'ok' ? __('Démon arrêté', __FILE__)
                    : ($paired ? count($fabrics) . ' ' . __('contrôleur(s)', __FILE__) : __('Non appairé', __FILE__)),
                'advice' => $paired ? '' : __('Appairez le pont depuis l\'application Google Home avec son QR code.', __FILE__),
                'state' => $info['state'] == 'ok' && $paired,
            );
        }
        return $return;
    }
}

class matterhubbeCmd extends cmd {

    public function execute($_options = array()) {
    }
}
