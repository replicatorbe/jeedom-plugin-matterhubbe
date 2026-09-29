<?php
/* Ce que le pont propose d'exposer, contrôlé hors ligne.
 *
 *   php tests/test_selection.php
 *
 * Ni Jeedom ni base : quelques classes de papier imitent eqLogic et cmd, et la
 * classe du plugin est chargée sans son require du cœur. Sont vérifiés les
 * choix qui engagent la sécurité ou le sens de ce que Google verra :
 *
 *   - une serrure n'est jamais cochée d'office, et elle est signalée ;
 *   - la sonde externe d'un module à relais (Shelly 1 + DS18B20) est proposée,
 *     sa température interne jamais ;
 *   - entre deux températures, celle qui n'est pas « interne » est exposée ;
 *   - un relais à risque reste signalé et décoché.
 *
 * Code de retour non nul dès qu'un contrôle échoue. */

function __($_texte, $_fichier = '') {
    return $_texte;
}

class eqLogic {
    public static $_all = array();
    protected $_data = array();
    protected $_cmds = array();

    public function __construct($_data = array(), $_cmds = array()) {
        $this->_data = $_data + array('isEnable' => 1, 'eqType_name' => 'essai', 'object' => null);
        $this->_cmds = $_cmds;
    }
    public static function all() {
        return self::$_all;
    }
    public static function byId($_id) {
        foreach (self::$_all as $eq) {
            if ($eq->getId() == $_id) {
                return $eq;
            }
        }
        return null;
    }
    public function getId() { return $this->_data['id']; }
    public function getName() { return $this->_data['name']; }
    public function getIsEnable() { return $this->_data['isEnable']; }
    public function getEqType_name() { return $this->_data['eqType_name']; }
    public function getObject() { return null; }
    public function getHumanName() { return '[' . $this->_data['name'] . ']'; }
    public function getCmd() { return $this->_cmds; }
}

class cmd {
    public static $_all = array();
    protected $_data = array();

    public function __construct($_data) {
        $this->_data = $_data + array('type' => 'info', 'subType' => 'numeric', 'logicalId' => '',
            'value' => '', 'display' => array(), 'configuration' => array(), 'unite' => '', 'current' => 20);
        self::$_all[$this->_data['id']] = $this;
    }
    public static function byId($_id) {
        return isset(self::$_all[$_id]) ? self::$_all[$_id] : null;
    }
    public function getId() { return $this->_data['id']; }
    public function getName() { return $this->_data['name']; }
    public function getGeneric_type() { return $this->_data['generic_type']; }
    public function getType() { return $this->_data['type']; }
    public function getSubType() { return $this->_data['subType']; }
    public function getLogicalId() { return $this->_data['logicalId']; }
    public function getValue() { return $this->_data['value']; }
    public function getUnite() { return $this->_data['unite']; }
    public function execCmd() { return $this->_data['current']; }
    public function getDisplay($_key = '', $_default = '') {
        return isset($this->_data['display'][$_key]) ? $this->_data['display'][$_key] : $_default;
    }
    public function getConfiguration($_key = '', $_default = '') {
        return isset($this->_data['configuration'][$_key]) ? $this->_data['configuration'][$_key] : $_default;
    }
}

class scenario {
    public static function all() { return array(); }
}

/* La classe du plugin, sans le require du cœur qui n'existe pas ici. */
$source = file_get_contents(__DIR__ . '/../core/class/matterhubbe.class.php');
$source = preg_replace('/^require_once .*core\.inc\.php.*$/m', '', $source, 1, $retire);
if ($retire !== 1) {
    fwrite(STDERR, "require du cœur introuvable dans matterhubbe.class.php\n");
    exit(1);
}
eval('?>' . $source);

/* ---------------------------------------------------------------- données */

/* Relais d'un Shelly 1 : état, on, off, basculer, liés à l'état. */
function relais($_base, $_types) {
    list($state, $on, $off, $toggle) = $_types;
    return array(
        new cmd(array('id' => $_base, 'name' => 'État', 'generic_type' => $state, 'subType' => 'binary', 'logicalId' => 'relay.0.state')),
        new cmd(array('id' => $_base + 1, 'name' => 'Allumer', 'generic_type' => $on, 'type' => 'action', 'subType' => 'other', 'value' => $_base)),
        new cmd(array('id' => $_base + 2, 'name' => 'Éteindre', 'generic_type' => $off, 'type' => 'action', 'subType' => 'other', 'value' => $_base)),
        new cmd(array('id' => $_base + 3, 'name' => 'Basculer', 'generic_type' => $toggle, 'type' => 'action', 'subType' => 'other', 'value' => $_base)),
    );
}

eqLogic::$_all = array(
    new eqLogic(array('id' => 101, 'name' => 'Verrou porte'),
        relais(1709, array('LOCK_STATE', 'LOCK_CLOSE', 'LOCK_OPEN', ''))),
    new eqLogic(array('id' => 95, 'name' => 'Temperature salon'), array_merge(
        relais(1657, array('ENERGY_STATE', 'ENERGY_ON', 'ENERGY_OFF', 'TOGGLE')),
        array(new cmd(array('id' => 1661, 'name' => 'Température externe 1', 'generic_type' => 'TEMPERATURE',
            'logicalId' => 'ext.temperature.0', 'current' => 21.4))))),
    new eqLogic(array('id' => 362, 'name' => 'Lampe plafond'), array_merge(
        relais(4272, array('LIGHT_STATE', 'LIGHT_ON', 'LIGHT_OFF', 'LIGHT_TOGGLE')),
        array(new cmd(array('id' => 4273, 'name' => 'Température interne', 'generic_type' => 'TEMPERATURE',
            'logicalId' => 'switch.0.temperature', 'current' => 38))))),
    new eqLogic(array('id' => 700, 'name' => 'Sonde double'), array(
        new cmd(array('id' => 7001, 'name' => 'Température interne', 'generic_type' => 'TEMPERATURE', 'current' => 30)),
        new cmd(array('id' => 7002, 'name' => 'Température', 'generic_type' => 'TEMPERATURE', 'current' => 19)))),
    new eqLogic(array('id' => 85, 'name' => 'Shelly Plug Modem EDPNET'),
        relais(1564, array('ENERGY_STATE', 'ENERGY_ON', 'ENERGY_OFF', 'TOGGLE'))),
);

/* --------------------------------------------------------------- contrôles */

$echecs = 0;
$reussis = 0;
function verifie($_titre, $_ok, $_detail = '') {
    global $echecs, $reussis;
    if ($_ok) {
        $reussis++;
        printf("  %s ... ok\n", $_titre);
    } else {
        $echecs++;
        printf("  %s ... ECHEC %s\n", $_titre, $_detail);
    }
}

$candidats = array();
foreach (matterhubbe::candidates() as $c) {
    $candidats[$c['eq_id'] . '/' . $c['family']] = $c;
}
$c = function ($_cle) use ($candidats) {
    return isset($candidats[$_cle]) ? $candidats[$_cle] : null;
};

$verrou = $c('101/lock');
verifie('le verrou est bien candidat (serrure)', $verrou !== null);
verifie('une serrure n\'est jamais cochée d\'office', $verrou !== null && $verrou['suggested'] === false);
verifie('une serrure est signalée', $verrou !== null && $verrou['warning'] !== '');
verifie('le verrou n\'apparaît pas en prise', $c('101/energy') === null);

$sonde = $c('95/temperature');
verifie('la sonde externe d\'un Shelly 1 est candidate', $sonde !== null);
verifie('la sonde externe d\'un module à relais est proposée', $sonde !== null && $sonde['suggested'] === true);

$interne = $c('362/temperature');
verifie('la température interne d\'une lampe n\'est pas proposée', $interne === null || $interne['suggested'] === false);
verifie('la lampe typée LIGHT_* est proposée en lumière', $c('362/light') !== null && $c('362/light')['suggested'] === true);

$analyse = matterhubbe::analyzeEquipment(eqLogic::byId(700));
verifie('entre deux températures, celle qui n\'est pas interne est exposée',
    isset($analyse['temperature']) && $analyse['temperature']['cmds']['value'] === 7002,
    json_encode(isset($analyse['temperature']) ? $analyse['temperature']['cmds'] : null));

$modem = $c('85/energy');
verifie('un relais à risque reste signalé et décoché', $modem !== null && $modem['suggested'] === false && $modem['warning'] !== '');

printf("\n  ==> %d réussi(s), %d échec(s)\n", $reussis, $echecs);
exit($echecs > 0 ? 1 : 0);
