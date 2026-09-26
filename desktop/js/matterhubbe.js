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

/* Noms d'équipements et d'objets : du texte, jamais du balisage. Guillemets
   compris, le résultat pouvant finir dans un attribut. */
function matterhubbeEscape(_text) {
  return String((_text === null || _text === undefined) ? '' : _text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* Sélection du pont affiché, indexée par équipement et famille. */
var matterhubbeSelection = {}
/* Sélection telle qu'enregistrée : pour avertir quand on change le type d'un appareil déjà dans Google. */
var matterhubbeSaved = {}
var matterhubbeCandidates = null
var matterhubbeBridgeId = null
var matterhubbePollTimer = null

function matterhubbeRowKey(_eqId, _family) {
  return _eqId + ':' + _family
}

/* domUtils.ajax signale déjà les erreurs réseau : pas de second message. */
function matterhubbeAjax(_action, _data, _success) {
  domUtils.ajax({
    type: 'POST',
    url: 'plugins/matterhubbe/core/ajax/matterhubbe.ajax.php',
    data: Object.assign({ action: _action }, _data || {}),
    dataType: 'json',
    success: function (result) {
      if (result.state != 'ok') {
        jeedomUtils.showAlert({ message: result.result, level: 'danger' })
        return
      }
      _success(result.result)
    }
  })
}

function matterhubbeMarkModified() {
  jeeFrontEnd.modifyWithoutSave = true
  window.modifyWithoutSave = true
}

/* ------------------------------------------------------------ appareils exposés */

/*
 * Nom par défaut, même règle que matterhubbe::defaultName() : celui de
 * l'équipement, suivi de la fonction si une autre fonction du même équipement,
 * venant avant, est aussi exposée.
 */
function matterhubbeDefaultName(_candidate) {
  for (var key in matterhubbeSelection) {
    var s = matterhubbeSelection[key]
    if (s.eq_id != _candidate.eq_id || s.family === _candidate.family) { continue }
    var other = matterhubbeFindCandidate(s.eq_id, s.family)
    if (other && other.familyOrder < _candidate.familyOrder) {
      return _candidate.name + ' ' + _candidate.familyLabel.toLowerCase()
    }
  }
  return _candidate.name
}

function matterhubbeFindCandidate(_eqId, _family) {
  if (!matterhubbeCandidates) { return null }
  for (var i = 0; i < matterhubbeCandidates.length; i++) {
    if (matterhubbeCandidates[i].eq_id == _eqId && matterhubbeCandidates[i].family === _family) {
      return matterhubbeCandidates[i]
    }
  }
  return null
}

function matterhubbeUpdateCount() {
  document.getElementById('span_matterhubbeCount').textContent = Object.keys(matterhubbeSelection).length
}

/* Aperçu des noms : placeholders à jour, et doublons signalés (l'assistant ne saurait pas lequel choisir). */
function matterhubbeRefreshNames() {
  var names = {}
  var rows = document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice')
  rows.forEach(function (_tr) {
    var candidate = matterhubbeFindCandidate(_tr.getAttribute('data-eq_id'), _tr.getAttribute('data-family'))
    var input = _tr.querySelector('.matterhubbeName')
    if (!candidate || !input) { return }
    input.setAttribute('placeholder', matterhubbeDefaultName(candidate))
    if (_tr.querySelector('.matterhubbeSelect').checked) {
      var name = (input.value.trim() || input.getAttribute('placeholder')).toLowerCase()
      names[name] = (names[name] || 0) + 1
    }
  })
  rows.forEach(function (_tr) {
    var input = _tr.querySelector('.matterhubbeName')
    if (!input) { return }
    var name = (input.value.trim() || input.getAttribute('placeholder') || '').toLowerCase()
    var duplicate = _tr.querySelector('.matterhubbeSelect').checked && names[name] > 1
    input.parentNode.classList.toggle('has-warning', duplicate)
    input.title = duplicate ? '{{Un autre appareil exposé porte ce nom : Google ne saura pas lequel piloter.}}' : ''
  })
}

function matterhubbeRenderDevices() {
  var tbody = document.getElementById('table_matterhubbeDevices').querySelector('tbody')
  tbody.innerHTML = ''
  if (matterhubbeCandidates === null) {
    return
  }

  /* Appareils enregistrés qui ne sont plus exposables : visibles, pour pouvoir les retirer. */
  for (var key in matterhubbeSelection) {
    var s = matterhubbeSelection[key]
    if (matterhubbeFindCandidate(s.eq_id, s.family)) { continue }
    var ghost = document.createElement('tr')
    ghost.classList.add('matterhubbeDevice', 'warning')
    ghost.setAttribute('data-key', key)
    ghost.setAttribute('data-eq_id', s.eq_id)
    ghost.setAttribute('data-family', s.family)
    ghost.setAttribute('data-search', '')
    ghost.innerHTML = '<td><input type="checkbox" class="matterhubbeSelect" checked></td>'
      + '<td colspan="4"><i class="fas fa-exclamation-triangle"></i> ' + matterhubbeEscape(s.name || ('#' + s.eq_id))
      + ' — {{cet équipement n\'existe plus ou n\'a plus les types génériques nécessaires : il n\'est plus envoyé à Google. Décochez-le pour le retirer.}}</td>'
    tbody.appendChild(ghost)
  }

  if (matterhubbeCandidates.length === 0) {
    var empty = document.createElement('tr')
    empty.innerHTML = '<td colspan="5">{{Aucun équipement n\'a de type générique exploitable. Renseignez-les dans Outils → Types génériques.}}</td>'
    tbody.appendChild(empty)
    return
  }

  var lastObject = null
  matterhubbeCandidates.forEach(function (_c) {
    if (_c.object !== lastObject) {
      lastObject = _c.object
      var header = document.createElement('tr')
      header.classList.add('matterhubbeObject')
      header.setAttribute('data-object', _c.object)
      header.innerHTML = '<th colspan="5" style="background-color:var(--bg-color-secondary, rgba(128,128,128,0.1));">'
        + '<i class="fas fa-folder-open"></i> ' + matterhubbeEscape(_c.object || '{{Sans objet}}') + '</th>'
      tbody.appendChild(header)
    }

    var key = matterhubbeRowKey(_c.eq_id, _c.family)
    var selected = matterhubbeSelection[key]
    var kind = (selected && selected.kind) ? selected.kind : _c.default

    var tr = document.createElement('tr')
    tr.classList.add('matterhubbeDevice')
    tr.setAttribute('data-key', key)
    tr.setAttribute('data-eq_id', _c.eq_id)
    tr.setAttribute('data-family', _c.family)
    tr.setAttribute('data-object', _c.object)
    tr.setAttribute('data-search', (_c.humanName + ' ' + _c.plugin + ' ' + _c.familyLabel).toLowerCase())

    var html = '<td><input type="checkbox" class="matterhubbeSelect"' + (selected ? ' checked' : '') + '></td>'
    html += '<td>' + matterhubbeEscape(_c.name)
    html += ' <span class="label label-default">' + matterhubbeEscape(_c.plugin) + '</span>'
    if (_c.isEnable != 1) {
      html += ' <span class="label label-warning" title="{{Désactivé dans Jeedom : Google le verra « hors ligne » tant qu\'il le restera.}}">{{désactivé}}</span>'
    }
    html += '</td>'
    html += '<td>' + matterhubbeEscape(_c.familyLabel) + '</td>'
    html += '<td>'
    if (_c.kinds.length > 1) {
      html += '<select class="form-control input-sm matterhubbeKind">'
      _c.kinds.forEach(function (_k) {
        html += '<option value="' + matterhubbeEscape(_k.kind) + '"' + (_k.kind === kind ? ' selected' : '') + '>' + matterhubbeEscape(_k.label) + '</option>'
      })
      html += '</select>'
    } else {
      html += matterhubbeEscape(_c.kinds[0].label)
    }
    html += '</td>'
    html += '<td><div><input class="form-control input-sm matterhubbeName" maxlength="32"></div></td>'
    tr.innerHTML = html
    if (selected && selected.name) {
      tr.querySelector('.matterhubbeName').value = selected.name
    }
    tbody.appendChild(tr)
  })
  matterhubbeRefreshNames()
  matterhubbeFilter()
}

function matterhubbeFilter() {
  var text = document.getElementById('in_matterhubbeFilter').value.trim().toLowerCase()
  var onlySelected = document.getElementById('bt_matterhubbeOnlySelected').getAttribute('data-state') === '1'
  var visibleObjects = {}
  document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice').forEach(function (_tr) {
    var search = _tr.getAttribute('data-search')
    var visible = (search === '' || text === '' || search.indexOf(text) >= 0)
    if (onlySelected && !_tr.querySelector('.matterhubbeSelect').checked) {
      visible = false
    }
    _tr.style.display = visible ? '' : 'none'
    if (visible) { visibleObjects[_tr.getAttribute('data-object')] = true }
  })
  document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeObject').forEach(function (_tr) {
    _tr.style.display = visibleObjects[_tr.getAttribute('data-object')] ? '' : 'none'
  })
}

/* Une ligne modifiée met à jour la sélection tout de suite : le filtre peut la masquer ensuite sans rien perdre. */
function matterhubbeReadRow(_tr) {
  var key = _tr.getAttribute('data-key')
  if (!_tr.querySelector('.matterhubbeSelect').checked) {
    delete matterhubbeSelection[key]
  } else {
    var kind = _tr.querySelector('.matterhubbeKind')
    var name = _tr.querySelector('.matterhubbeName')
    var previous = matterhubbeSelection[key] || {}
    matterhubbeSelection[key] = {
      eq_id: parseInt(_tr.getAttribute('data-eq_id')),
      family: _tr.getAttribute('data-family'),
      kind: kind ? kind.value : (previous.kind || ''),
      name: name ? name.value.trim() : (previous.name || '')
    }
  }
  matterhubbeUpdateCount()
}

function matterhubbeLoadCandidates() {
  matterhubbeAjax('candidates', {}, function (_result) {
    matterhubbeCandidates = _result.candidates
    matterhubbeRenderDevices()
  })
}

/* ------------------------------------------------------------ appairage */

var matterhubbeConsoleHelp = '{{Avant le premier appairage, le pont doit être déclaré (gratuitement) dans la}} '
  + '<a href="https://console.home.google.com/" target="_blank" rel="noopener">Google Home Developer Console</a>'
  + ' {{avec le compte Google de la maison : projet → Add Matter integration, Vendor ID <b>0xFFF1</b>, Product ID <b>0x8000</b>. Sans cela, Google refuse l\'appareil.}}'

function matterhubbeRenderStatus(_status) {
  var div = document.getElementById('div_matterhubbeStatus')
  if (_status.id != matterhubbeBridgeId) {
    return
  }
  var html = ''
  if (_status.enabled != 1) {
    div.innerHTML = '<div class="alert alert-warning">{{Ce pont est désactivé : cochez « Activer » et enregistrez pour le démarrer.}}</div>'
    return
  }
  if (_status.dependancy !== 'ok') {
    div.innerHTML = '<div class="alert alert-warning">'
      + (_status.dependancy === 'in_progress'
        ? '{{Installation des dépendances en cours (Node.js et la bibliothèque Matter). Cela peut prendre une vingtaine de minutes.}}'
        : '{{Les dépendances ne sont pas installées : Plugins → Gestion des plugins → Matter Hub → Dépendances → Relancer.}}')
      + '</div>'
    return
  }
  if (_status.daemon !== 'ok') {
    html = '<div class="alert alert-warning">{{Le démon est arrêté.}}'
    if (_status.launchableMessage) {
      html += ' ' + matterhubbeEscape(_status.launchableMessage)
    }
    html += '</div>'
    if (_status.launchable === 'ok') {
      html += '<a class="btn btn-success btn-sm" id="bt_matterhubbeStartDaemon"><i class="fas fa-play"></i> {{Démarrer le démon}}</a>'
    }
    div.innerHTML = html
    return
  }
  if (!_status.inDaemon) {
    if (_status.error) {
      div.innerHTML = '<div class="alert alert-danger">{{Le pont n\'a pas pu démarrer :}} ' + matterhubbeEscape(_status.error)
        + '<br>{{Nouvel essai automatique chaque minute. Si le port est pris par un autre logiciel, changez-le à gauche.}}</div>'
    } else {
      div.innerHTML = '<span class="help-block"><i class="fas fa-spinner fa-spin"></i> {{Démarrage du pont…}}</span>'
      matterhubbeSchedulePoll(3000)
    }
    return
  }

  var fabrics = Array.isArray(_status.fabrics) ? _status.fabrics : []
  if (_status.selected == 0) {
    html += '<div class="alert alert-warning">{{Aucun appareil n\'est coché : choisissez-les dans l\'onglet « Appareils exposés » avant d\'appairer, Google n\'aurait rien à afficher.}}</div>'
  }
  if (!_status.commissioned) {
    html += '<div class="alert alert-info">' + matterhubbeConsoleHelp + '</div>'
    html += '<ol style="padding-left:20px;">'
    html += '<li>{{Application Google Home : Ajouter → Appareil Matter.}}</li>'
    html += '<li>{{Scannez ce QR code, ou choisissez « Configurer sans code QR » et saisissez le code à 11 chiffres.}}</li>'
    html += '<li>{{« Appareil non certifié » : c\'est normal, confirmez l\'ajout.}}</li>'
    html += '</ol>'
  } else {
    html += '<div class="alert alert-success">{{Pont appairé.}} ' + fabrics.length + ' {{contrôleur(s) :}} '
    html += fabrics.map(function (_f) {
      return matterhubbeEscape(matterhubbeVendor(_f.vendorId) + (_f.label ? ' (' + _f.label + ')' : ''))
    }).join(', ')
    html += '</div>'
  }
  html += '<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;">'
  if (_status.qrSvg) {
    var img = 'data:image/svg+xml;base64,' + btoa(_status.qrSvg)
    html += '<img src="' + img + '" alt="QR code" style="width:200px;height:200px;image-rendering:pixelated;'
      + (_status.commissioned ? 'opacity:0.3;' : '') + '">'
  }
  html += '<div>'
  html += '<div>{{Code manuel}}</div>'
  html += '<div style="font-size:24px;font-family:monospace;letter-spacing:2px;' + (_status.commissioned ? 'opacity:0.4;' : '') + '">'
    + matterhubbeEscape(matterhubbeFormatCode(_status.manualPairingCode)) + '</div>'
  html += '<div class="help-block">{{Port}} ' + parseInt(_status.port) + ' — ' + parseInt(_status.devices) + ' {{appareil(s) exposé(s)}}</div>'
  if (_status.commissioned) {
    html += '<div class="help-block">{{Code utilisable seulement après « Ouvrir l\'appairage » (15 minutes) : pour réappairer Google ou ajouter un second contrôleur.}}</div>'
    html += '<a class="btn btn-default btn-sm" id="bt_matterhubbeOpenCommissioning"><i class="fas fa-door-open"></i> {{Ouvrir l\'appairage}}</a>'
  }
  html += '</div></div>'
  html += '<hr><a class="btn btn-danger btn-xs pull-right" id="bt_matterhubbeFactoryReset"><i class="fas fa-eraser"></i> {{Réinitialiser le pont}}</a>'
  html += '<span class="help-block">{{La réinitialisation oublie Google et génère un nouveau code : à réserver aux cas désespérés.}}</span>'
  div.innerHTML = html

  /* En attente d'appairage : la page passe d'elle-même à « Appairé » après le scan. */
  if (!_status.commissioned) {
    matterhubbeSchedulePoll(5000)
  }
}

function matterhubbeVendor(_vendorId) {
  var vendors = { 24582: 'Google', 4937: 'Apple', 4996: 'Apple', 4631: 'Amazon', 4448: 'Amazon', 4362: 'SmartThings', 65521: '{{Test}}' }
  return vendors[_vendorId] || ('{{Fabricant}} ' + _vendorId)
}

/* 11 chiffres en 4-3-4, comme sur les étiquettes Matter. */
function matterhubbeFormatCode(_code) {
  var code = String(_code || '')
  if (code.length !== 11) {
    return code
  }
  return code.slice(0, 4) + '-' + code.slice(4, 7) + '-' + code.slice(7)
}

/* Une seule interrogation en attente, et seulement tant que l'onglet du pont est affiché. */
function matterhubbeSchedulePoll(_delay) {
  clearTimeout(matterhubbePollTimer)
  matterhubbePollTimer = setTimeout(function () {
    var status = document.getElementById('div_matterhubbeStatus')
    if (status === null || status.offsetParent === null) { return }
    matterhubbeLoadStatus()
  }, _delay)
}

function matterhubbeLoadStatus() {
  if (!matterhubbeBridgeId) {
    return
  }
  var id = matterhubbeBridgeId
  matterhubbeAjax('status', { id: id }, function (_status) {
    /* Réponse arrivée après être passé à un autre pont : ignorée. */
    if (id == matterhubbeBridgeId) {
      matterhubbeRenderStatus(_status)
    }
  })
}

function matterhubbeConfirm(_message, _callback) {
  if (typeof jeeDialog !== 'undefined' && jeeDialog.confirm) {
    jeeDialog.confirm(_message, _callback)
  } else {
    bootbox.confirm(_message, _callback)
  }
}

/* ------------------------------------------------------------ hooks du cœur */

/* Appelé par plugin.template.js une fois l'équipement chargé. */
function printEqLogic(_eqLogic) {
  clearTimeout(matterhubbePollTimer)
  matterhubbeBridgeId = _eqLogic.id
  matterhubbeSelection = {}
  matterhubbeSaved = {}
  var devices = init(_eqLogic.configuration.devices, [])
  if (typeof devices === 'string') {
    try { devices = JSON.parse(devices) } catch (e) { devices = [] }
  }
  if (Array.isArray(devices)) {
    devices.forEach(function (_d) {
      var key = matterhubbeRowKey(_d.eq_id, _d.family)
      matterhubbeSelection[key] = _d
      matterhubbeSaved[key] = _d
    })
  }
  document.getElementById('in_matterhubbeFilter').value = ''
  var only = document.getElementById('bt_matterhubbeOnlySelected')
  only.setAttribute('data-state', '0')
  only.classList.remove('btn-success')
  only.classList.add('btn-default')

  matterhubbeUpdateCount()
  document.getElementById('div_matterhubbeStatus').innerHTML = '<span class="help-block">{{Lecture de l\'état du pont…}}</span>'
  matterhubbeLoadStatus()
  if (matterhubbeCandidates === null) {
    matterhubbeLoadCandidates()
  } else {
    matterhubbeRenderDevices()
  }
}

/* Appelé par plugin.template.js avant l'enregistrement. */
function saveEqLogic(_eqLogic) {
  document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice').forEach(matterhubbeReadRow)
  _eqLogic.configuration.devices = Object.values(matterhubbeSelection)
  /* Le démon relit la configuration une fois l'enregistrement fini : on guette le résultat. */
  matterhubbeSchedulePoll(3000)
  return _eqLogic
}

function addCmdToTable(_cmd) {
  if (!isset(_cmd)) {
    var _cmd = { configuration: {} }
  }
  var tr = '<td>'
  /* Sans ce champ, chaque enregistrement détruit puis recrée les commandes. */
  tr += '<span class="cmdAttr" data-l1key="id" style="display:none;"></span>'
  tr += '<input class="cmdAttr form-control input-sm" data-l1key="name" placeholder="{{Nom}}">'
  tr += '</td>'
  tr += '<td>'
  tr += '<span class="type" type="' + init(_cmd.type) + '">' + jeedom.cmd.availableType() + '</span>'
  tr += '<span class="subType" subType="' + init(_cmd.subType) + '"></span>'
  tr += '</td>'
  tr += '<td>'
  tr += '<label class="checkbox-inline"><input type="checkbox" class="cmdAttr" data-l1key="isVisible" checked>{{Afficher}}</label>'
  tr += '<label class="checkbox-inline"><input type="checkbox" class="cmdAttr" data-l1key="isHistorized">{{Historiser}}</label>'
  tr += '<span class="cmdAttr" data-l1key="htmlstate" style="display:inline-block;margin-left:5px;"></span>'
  tr += '</td>'
  tr += '<td>'
  if (is_numeric(_cmd.id)) {
    tr += '<a class="btn btn-default btn-xs cmdAction" data-action="configure"><i class="fas fa-cogs"></i></a> '
  }
  tr += '</td>'

  /* Ligne créée en DOM : insertAdjacentHTML sur une table génère un <tbody> par insertion. */
  var newRow = document.createElement('tr')
  newRow.innerHTML = tr
  newRow.classList.add('cmd')
  newRow.setAttribute('data-cmd_id', init(_cmd.id))
  document.getElementById('table_cmd').querySelector('tbody').appendChild(newRow)
  newRow.setJeeValues(_cmd, '.cmdAttr')
  jeedom.cmd.changeType(newRow, init(_cmd.subType))
}

/* ------------------------------------------------------------ écouteurs */

/* Les pages de plugin sont chargées en ajax : DOMContentLoaded a déjà eu lieu.
   Revenir sur la page rejoue ce script : les écouteurs précédents sont retirés. */
var matterhubbeContainer = document.getElementById('div_pageContainer') || document.body

if (window.matterhubbeOnClick) {
  matterhubbeContainer.removeEventListener('click', window.matterhubbeOnClick)
  matterhubbeContainer.removeEventListener('change', window.matterhubbeOnChange)
  matterhubbeContainer.removeEventListener('input', window.matterhubbeOnInput)
}

window.matterhubbeOnClick = function (_event) {
  var target = _event.target
  if (target === null) { return }

  if (target.closest('a[href="#eqlogictab"]') !== null) {
    matterhubbeSchedulePoll(300)
    return
  }
  if (target.closest('#bt_matterhubbeRefresh') !== null) {
    _event.preventDefault()
    matterhubbeLoadStatus()
    return
  }
  if (target.closest('#bt_matterhubbeReloadCandidates') !== null) {
    _event.preventDefault()
    document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice').forEach(matterhubbeReadRow)
    matterhubbeLoadCandidates()
    return
  }
  if (target.closest('#bt_matterhubbeCheckVisible') !== null || target.closest('#bt_matterhubbeUncheckVisible') !== null) {
    _event.preventDefault()
    var check = target.closest('#bt_matterhubbeCheckVisible') !== null
    document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice').forEach(function (_tr) {
      if (_tr.style.display === 'none') { return }
      var box = _tr.querySelector('.matterhubbeSelect')
      if (box.checked !== check) {
        box.checked = check
        matterhubbeReadRow(_tr)
      }
    })
    matterhubbeMarkModified()
    matterhubbeRefreshNames()
    return
  }
  if (target.closest('#bt_matterhubbeOnlySelected') !== null) {
    _event.preventDefault()
    var button = target.closest('#bt_matterhubbeOnlySelected')
    var on = button.getAttribute('data-state') !== '1'
    button.setAttribute('data-state', on ? '1' : '0')
    button.classList.toggle('btn-success', on)
    button.classList.toggle('btn-default', !on)
    matterhubbeFilter()
    return
  }
  if (target.closest('#bt_matterhubbeStartDaemon') !== null) {
    _event.preventDefault()
    jeedom.plugin.deamonStart({
      id: 'matterhubbe',
      forceRestart: 1,
      success: function () { matterhubbeSchedulePoll(3000) }
    })
    return
  }
  if (target.closest('#bt_matterhubbeOpenCommissioning') !== null) {
    _event.preventDefault()
    matterhubbeAjax('openCommissioning', { id: matterhubbeBridgeId }, function (_message) {
      jeedomUtils.showAlert({ message: _message || '{{Appairage ouvert pour 15 minutes : ajoutez le pont depuis l\'application avec le code affiché.}}', level: 'success' })
      matterhubbeLoadStatus()
    })
    return
  }
  if (target.closest('#bt_matterhubbeFactoryReset') !== null) {
    _event.preventDefault()
    matterhubbeConfirm('{{Réinitialiser le pont ? Google Home et tout autre contrôleur le perdront, avec les pièces et les routines qui utilisent ses appareils. Un nouveau code d\'appairage sera généré.}}', function (_ok) {
      if (!_ok) { return }
      matterhubbeAjax('factoryReset', { id: matterhubbeBridgeId }, function () {
        jeedomUtils.showAlert({ message: '{{Pont réinitialisé : supprimez-le aussi de l\'application Google Home avant de le réappairer.}}', level: 'success' })
        matterhubbeSchedulePoll(3000)
      })
    })
  }
}

window.matterhubbeOnChange = function (_event) {
  var tr = _event.target.closest('#table_matterhubbeDevices tr.matterhubbeDevice')
  if (tr === null) { return }
  matterhubbeReadRow(tr)
  matterhubbeMarkModified()
  matterhubbeRefreshNames()
  /* Le type fait partie de l'identité de l'appareil : Google en verra un nouveau. */
  if (_event.target.classList.contains('matterhubbeKind') && matterhubbeSaved[tr.getAttribute('data-key')]) {
    jeedomUtils.showAlert({
      message: '{{Changer le type d\'un appareil déjà dans Google Home le recrée : il faudra le ranger à nouveau dans sa pièce et mettre à jour les routines qui l\'utilisent.}}',
      level: 'warning'
    })
  }
}

window.matterhubbeOnInput = function (_event) {
  if (_event.target.id === 'in_matterhubbeFilter') {
    matterhubbeFilter()
    return
  }
  var tr = _event.target.closest('#table_matterhubbeDevices tr.matterhubbeDevice')
  if (tr !== null) {
    matterhubbeReadRow(tr)
    matterhubbeMarkModified()
    matterhubbeRefreshNames()
  }
}

matterhubbeContainer.addEventListener('click', window.matterhubbeOnClick)
matterhubbeContainer.addEventListener('change', window.matterhubbeOnChange)
matterhubbeContainer.addEventListener('input', window.matterhubbeOnInput)
