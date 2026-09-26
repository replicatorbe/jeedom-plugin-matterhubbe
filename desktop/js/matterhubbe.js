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
function matterhubbeAjax(_action, _data, _success, _failure) {
  domUtils.ajax({
    type: 'POST',
    url: 'plugins/matterhubbe/core/ajax/matterhubbe.ajax.php',
    data: Object.assign({ action: _action }, _data || {}),
    dataType: 'json',
    /* Le cœur affiche déjà l'erreur réseau : ici, seulement remettre la page d'aplomb. */
    error: function () { if (_failure) { _failure() } },
    success: function (result) {
      if (result.state != 'ok') {
        jeedomUtils.showAlert({ message: result.result, level: 'danger' })
        if (_failure) { _failure() }
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
    var help = input.parentNode.querySelector('.matterhubbeNameHelp')
    var tooLong = !input.value.trim() && (input.getAttribute('placeholder') || '').length > 32
    var message = duplicate ? '{{Nom déjà utilisé par un autre appareil exposé : Google ne saura pas lequel piloter.}}'
      : (tooLong ? '{{Nom par défaut trop long : il sera coupé à 32 caractères.}}' : '')
    if (help) {
      help.textContent = message
      help.style.display = message ? '' : 'none'
    }
  })
}

function matterhubbeRenderDevices() {
  var tbody = document.getElementById('table_matterhubbeDevices').querySelector('tbody')
  tbody.innerHTML = ''
  if (matterhubbeCandidates === null) {
    tbody.innerHTML = '<tr><td colspan="5"><i class="fas fa-spinner fa-spin"></i> {{Lecture des équipements…}}</td></tr>'
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
      + '<td colspan="4"><i class="fas fa-exclamation-triangle"></i> ' + matterhubbeEscape(s.name || s.label || ('{{Équipement}} #' + s.eq_id))
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

    var html = '<td><input type="checkbox" class="matterhubbeSelect" aria-label="{{Exposer}} ' + matterhubbeEscape(_c.humanName + ' — ' + _c.familyLabel) + '"' + (selected ? ' checked' : '') + '></td>'
    html += '<td>' + matterhubbeEscape(_c.name)
    html += ' <span class="label label-default">' + matterhubbeEscape(_c.plugin) + '</span>'
    if (_c.isEnable != 1) {
      html += ' <span class="label label-warning" title="{{Désactivé dans Jeedom : Google le verra « hors ligne » tant qu\'il le restera.}}">{{désactivé}}</span>'
    }
    if (_c.warning) {
      html += ' <span class="label label-danger"><i class="fas fa-exclamation-triangle"></i> ' + matterhubbeEscape(_c.warning) + '</span>'
    }
    html += '</td>'
    html += '<td>' + matterhubbeEscape(_c.familyLabel) + '</td>'
    html += '<td>'
    if (_c.kinds.length > 1) {
      html += '<select class="form-control input-sm matterhubbeKind" aria-label="{{Apparaît comme}}">'
      _c.kinds.forEach(function (_k) {
        html += '<option value="' + matterhubbeEscape(_k.kind) + '"' + (_k.kind === kind ? ' selected' : '') + '>' + matterhubbeEscape(_k.label) + '</option>'
      })
      html += '</select>'
    } else {
      html += matterhubbeEscape(_c.kinds[0].label)
    }
    /* Options affichées seulement sur les lignes cochées : l'écran reste lisible, surtout sur téléphone. */
    html += '<div class="matterhubbeOptions"' + (selected ? '' : ' style="display:none;"') + '>' + matterhubbeOptionsHtml(_c, selected) + '</div>'
    html += '</td>'
    html += '<td><div><input class="form-control input-sm matterhubbeName" maxlength="32" aria-label="{{Nom dans Google Home}}">'
      + '<span class="help-block matterhubbeNameHelp" style="display:none;margin:2px 0 0 0;"></span></div></td>'
    tr.innerHTML = html
    if (selected && selected.name) {
      tr.querySelector('.matterhubbeName').value = selected.name
    }
    tbody.appendChild(tr)
  })
  matterhubbeRefreshNames()
  matterhubbeFilter()
}

/*
 * Options propres à certaines fonctions : sens inversé (volet, serrure,
 * ouverture), et modes Jeedom qui répondent à « arrêt » et « chauffage » pour
 * un thermostat.
 */
function matterhubbeOptionsHtml(_c, _selected) {
  var html = ''
  if (_c.invertable) {
    var inverted = _selected && _selected.invert
    html += '<label class="checkbox-inline" style="margin-top:4px;" title="{{À cocher si Google affiche l\'inverse de la réalité (ouvert au lieu de fermé, verrouillée au lieu d\'ouverte).}}">'
      + '<input type="checkbox" class="matterhubbeInvert"' + (inverted ? ' checked' : '') + '> {{Inverser}}</label>'
  }
  if (_c.family === 'thermostat') {
    var pick = function (_which, _label, _default) {
      var current = (_selected && _selected[_which] !== undefined) ? _selected[_which] : _default
      var out = '<div style="margin-top:4px;"><label style="font-weight:normal;margin:0;"><small>' + _label + '</small><select class="form-control input-sm matterhubbeMode" data-which="' + _which + '">'
      out += '<option value=""' + (current === '' ? ' selected' : '') + '>{{Aucun}}</option>'
      _c.modes.forEach(function (_m) {
        out += '<option value="' + matterhubbeEscape(_m.key) + '"' + (_m.key === current ? ' selected' : '') + '>' + matterhubbeEscape(_m.label) + '</option>'
      })
      return out + '</select></label></div>'
    }
    if (_c.modes.length > 0) {
      html += pick('offMode', '{{Mode « arrêt »}}', _c.defaultOff)
      html += pick('heatMode', '{{Mode « chauffage »}}', _c.defaultHeat)
    } else {
      html += '<div class="help-block" style="margin:4px 0 0 0;">{{Aucun mode (THERMOSTAT_SET_MODE) : seule la consigne sera pilotable.}}</div>'
    }
  }
  return html
}

function matterhubbeFilter() {
  var text = document.getElementById('in_matterhubbeFilter').value.trim().toLowerCase()
  var onlySelected = document.getElementById('bt_matterhubbeOnlySelected').getAttribute('data-state') === '1'
  var object = document.getElementById('sel_matterhubbeObject').value
  var family = document.getElementById('sel_matterhubbeFamily').value
  var visibleObjects = {}
  document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice').forEach(function (_tr) {
    var search = _tr.getAttribute('data-search')
    var visible = (search === '' || text === '' || search.indexOf(text) >= 0)
    if (object !== '' && ('=' + _tr.getAttribute('data-object')) !== object) { visible = false }
    if (family !== '' && _tr.getAttribute('data-family') !== family) { visible = false }
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
    var invert = _tr.querySelector('.matterhubbeInvert')
    var previous = matterhubbeSelection[key] || {}
    var item = Object.assign({}, previous, {
      eq_id: parseInt(_tr.getAttribute('data-eq_id')),
      family: _tr.getAttribute('data-family'),
      kind: kind ? kind.value : (previous.kind || ''),
      name: name ? name.value.trim() : (previous.name || '')
    })
    if (invert) { item.invert = invert.checked ? 1 : 0 }
    var candidate = matterhubbeFindCandidate(item.eq_id, item.family)
    if (candidate) { item.label = candidate.humanName }
    _tr.querySelectorAll('.matterhubbeMode').forEach(function (_select) {
      item[_select.getAttribute('data-which')] = _select.value
    })
    matterhubbeSelection[key] = item
  }
  matterhubbeUpdateCount()
}

function matterhubbeLoadCandidates() {
  matterhubbeAjax('candidates', {}, function (_result) {
    matterhubbeCandidates = _result.candidates
    matterhubbeFillFilters()
    matterhubbeRenderDevices()
  })
}

/* Listes « pièce » et « fonction » tirées des équipements proposés ; le choix en cours est gardé. */
function matterhubbeFillFilters() {
  var fill = function (_id, _values) {
    var select = document.getElementById(_id)
    var current = select.value
    while (select.options.length > 1) { select.remove(1) }
    _values.forEach(function (_v) {
      var option = document.createElement('option')
      option.value = _v.value
      option.textContent = _v.label
      select.appendChild(option)
    })
    select.value = current
    if (select.value !== current) { select.value = '' }
  }
  var objects = {}
  var families = {}
  matterhubbeCandidates.forEach(function (_c) {
    objects[_c.object] = _c.object || '{{Sans objet}}'
    families[_c.family] = _c.familyLabel
  })
  fill('sel_matterhubbeObject', Object.keys(objects).sort().map(function (_k) { return { value: '=' + _k, label: objects[_k] } }))
  fill('sel_matterhubbeFamily', Object.keys(families).map(function (_k) { return { value: _k, label: families[_k] } }))
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
        ? '<i class="fas fa-spinner fa-spin"></i> {{Installation des dépendances en cours (Node.js et la bibliothèque Matter) : jusqu\'à une vingtaine de minutes. Cette page se met à jour toute seule.}}'
        : '{{Les dépendances ne sont pas installées : Plugins → Gestion des plugins → Matter Hub → Dépendances → Relancer.}}')
      + '</div>'
    matterhubbeSchedulePoll(15000)
    return
  }
  if (_status.daemon !== 'ok') {
    html = '<div class="alert alert-warning">{{Le démon est arrêté.}}'
    if (_status.launchableMessage) {
      html += ' ' + matterhubbeEscape(_status.launchableMessage)
    }
    html += '</div>'
    if (_status.launchable === 'ok') {
      html += '<a class="btn btn-success btn-sm" id="bt_matterhubbeStartDaemon" role="button" tabindex="0"><i class="fas fa-play"></i> {{Démarrer le démon}}</a>'
    }
    div.innerHTML = html
    matterhubbeSchedulePoll(15000)
    return
  }
  if (!_status.inDaemon) {
    if (_status.error) {
      div.innerHTML = '<div class="alert alert-danger">{{Le pont n\'a pas pu démarrer :}} ' + matterhubbeEscape(_status.error)
        + '<br>{{Nouvel essai automatique chaque minute. Si le port est pris, changez le champ « Port Matter » puis enregistrez.}}</div>'
      matterhubbeSchedulePoll(15000)
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
    html += '<div class="alert alert-success"><i class="fas fa-check"></i> {{Appairé avec :}} '
    html += fabrics.map(function (_f) {
      return matterhubbeEscape(matterhubbeVendor(_f.vendorId) + (_f.label ? ' (' + _f.label + ')' : ''))
    }).join(', ')
    html += '<br><small>{{Dans l\'application Google Home, rangez chaque appareil dans sa pièce, puis essayez : « Ok Google, allume le plafonnier du salon ».}}</small>'
    html += '</div>'
    if (_status.commissioningOpen) {
      html += '<div class="alert alert-info"><i class="fas fa-door-open"></i> {{Appairage ouvert : le code ci-dessous est utilisable pendant 15 minutes.}}</div>'
    }
  }
  html += '<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;">'
  if (_status.qrSvg) {
    var dim = _status.commissioned && !_status.commissioningOpen
    var img = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(_status.qrSvg)
    html += '<img src="' + img + '" alt="{{QR code d\'appairage Matter}}" style="width:200px;height:200px;image-rendering:pixelated;'
      + (dim ? 'opacity:0.3;' : '') + '">'
  }
  html += '<div>'
  html += '<div>{{Code manuel}}</div>'
  html += '<div style="font-size:24px;font-family:monospace;letter-spacing:2px;' + (dim ? 'opacity:0.4;' : '') + '">'
    + matterhubbeEscape(matterhubbeFormatCode(_status.manualPairingCode)) + '</div>'
  html += '<div class="help-block">{{Port}} ' + parseInt(_status.port) + ' — ' + parseInt(_status.devices) + ' {{appareil(s) exposé(s)}}</div>'
  if (_status.commissioned && !_status.commissioningOpen) {
    html += '<div class="help-block">{{Pour réappairer Google ou ajouter un autre contrôleur, autorisez d\'abord un nouvel appairage (15 minutes).}}</div>'
    html += '<a class="btn btn-default btn-sm" id="bt_matterhubbeOpenCommissioning" role="button" tabindex="0"><i class="fas fa-door-open"></i> {{Autoriser un nouvel appairage}}</a>'
  }
  html += '</div></div>'
  html += matterhubbeSummaryHtml(_status.summary)
  if (_status.commissioned) {
    html += '<hr><a class="btn btn-danger btn-xs pull-right" id="bt_matterhubbeFactoryReset" role="button" tabindex="0"><i class="fas fa-eraser"></i> {{Réinitialiser le pont}}</a>'
    html += '<span class="help-block">{{La réinitialisation oublie Google et génère un nouveau code : en dernier recours seulement.}}</span>'
  }
  div.innerHTML = html

  /* En attente d'appairage : la page passe d'elle-même à « Appairé » après le scan. */
  if (!_status.commissioned) {
    matterhubbeSchedulePoll(5000)
  }
}

/* « Ce que Google voit » : appareils par type, ceux hors ligne, et les coches qui ne donnent plus rien. */
function matterhubbeSummaryHtml(_summary) {
  if (!_summary || !_summary.types) { return '' }
  var types = Object.keys(_summary.types)
  if (types.length === 0) { return '' }
  var html = '<fieldset style="margin-top:15px;"><legend style="font-size:14px;"><i class="fas fa-eye"></i> {{Ce que Google voit}}</legend><ul style="padding-left:20px;margin:0;">'
  types.forEach(function (_t) {
    html += '<li>' + parseInt(_summary.types[_t]) + ' × ' + matterhubbeEscape(_t) + '</li>'
  })
  html += '</ul>'
  var offline = Array.isArray(_summary.offline) ? _summary.offline : []
  if (offline.length > 0) {
    html += '<div class="help-block" style="margin-bottom:0;"><i class="fas fa-plug"></i> {{Hors ligne dans Google (équipement désactivé ou module déconnecté) :}} '
      + offline.map(matterhubbeEscape).join(', ') + '</div>'
  }
  if (_summary.ignored > 0) {
    html += '<div class="help-block" style="margin-bottom:0;"><i class="fas fa-exclamation-triangle"></i> ' + parseInt(_summary.ignored)
      + ' {{appareil(s) coché(s) mais plus exposable(s) : voir en tête de l\'onglet « Appareils exposés ».}}</div>'
  }
  return html + '</fieldset>'
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
  }, function () {
    if (id == matterhubbeBridgeId) {
      document.getElementById('div_matterhubbeStatus').innerHTML = '<div class="alert alert-warning">{{État du pont illisible.}} '
        + '<a class="btn btn-default btn-xs" id="bt_matterhubbeRetry" role="button" tabindex="0"><i class="fas fa-sync"></i> {{Réessayer}}</a></div>'
    }
  })
}

/*
 * Proposition de sélection : coche ce que le plugin juge utile dans Google,
 * sans jamais rien décocher de ce que l'utilisateur a déjà choisi. Un relais
 * dont le nom parle d'éclairage est proposé en « Lumière ».
 */
function matterhubbeSuggest() {
  if (!matterhubbeCandidates) { return }
  var added = []
  matterhubbeCandidates.forEach(function (_c) {
    var key = matterhubbeRowKey(_c.eq_id, _c.family)
    if (_c.suggested && !matterhubbeSelection[key]) { added.push(_c) }
  })
  if (added.length === 0) {
    jeedomUtils.showAlert({ message: '{{Rien de plus à proposer : tout ce qui est utile est déjà coché.}}', level: 'info' })
    return
  }
  matterhubbeConfirm('{{Cocher}} ' + added.length + ' {{appareil(s) proposé(s) ? Ce qui est déjà coché reste coché ; vous pourrez tout relire avant d\'enregistrer.}}', function (_ok) {
    if (!_ok) { return }
    added.forEach(function (_c) {
      var item = { eq_id: _c.eq_id, family: _c.family, kind: _c.suggestedKind || _c.default, name: '', label: _c.humanName }
      matterhubbeSelection[matterhubbeRowKey(_c.eq_id, _c.family)] = item
    })
    matterhubbeMarkModified()
    matterhubbeUpdateCount()
    matterhubbeRenderDevices()
    var only = document.getElementById('bt_matterhubbeOnlySelected')
    only.setAttribute('data-state', '1')
    only.classList.add('btn-success')
    only.classList.remove('btn-default')
    matterhubbeFilter()
    jeedomUtils.showAlert({ message: added.length + ' {{appareil(s) coché(s). Relisez la liste (seuls les cochés sont affichés), puis enregistrez.}}', level: 'success' })
  })
}

/*
 * Noms automatiques : remplit les noms vides des appareils cochés avec le nom
 * lisible proposé par le plugin. Un nom déjà saisi n'est jamais remplacé.
 */
function matterhubbeAutoNames() {
  var changed = 0
  document.querySelectorAll('#table_matterhubbeDevices tr.matterhubbeDevice').forEach(function (_tr) {
    var box = _tr.querySelector('.matterhubbeSelect')
    var input = _tr.querySelector('.matterhubbeName')
    var candidate = matterhubbeFindCandidate(_tr.getAttribute('data-eq_id'), _tr.getAttribute('data-family'))
    if (!box || !box.checked || !input || input.value.trim() !== '' || !candidate) { return }
    /* Le nom proposé porte déjà la fonction quand il le faut (« Température salon ») : utilisé tel quel. */
    var name = candidate.suggestedName || ''
    if (name === '' || name === matterhubbeDefaultName(candidate)) { return }
    input.value = name.slice(0, 32)
    matterhubbeReadRow(_tr)
    changed++
  })
  if (changed === 0) {
    jeedomUtils.showAlert({ message: '{{Aucun nom à proposer : les appareils cochés ont déjà un nom lisible ou un nom saisi.}}', level: 'info' })
    return
  }
  matterhubbeMarkModified()
  matterhubbeRefreshNames()
  jeedomUtils.showAlert({ message: changed + ' {{nom(s) proposé(s) : relisez-les (vous pouvez les modifier), puis enregistrez.}}', level: 'success' })
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
  document.getElementById('div_matterhubbeStatus').innerHTML = '<span class="help-block"><i class="fas fa-spinner fa-spin"></i> {{Lecture de l\'état du pont…}}</span>'
  matterhubbeLoadStatus()
  /* Après un enregistrement, la page est rechargée avant que le démon ait relu la configuration : seconde lecture. */
  matterhubbeSchedulePoll(4000)
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
  /* Commandes créées par le plugin : leur type ne se change pas. */
  newRow.querySelectorAll('.cmdAttr[data-l1key="type"], .cmdAttr[data-l1key="subType"]').forEach(function (_select) {
    _select.disabled = true
  })
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
  if (target.closest('#bt_matterhubbeRefresh') !== null || target.closest('#bt_matterhubbeRetry') !== null) {
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
  if (target.closest('#bt_matterhubbeSuggest') !== null) {
    _event.preventDefault()
    matterhubbeSuggest()
    return
  }
  if (target.closest('#bt_matterhubbeAutoNames') !== null) {
    _event.preventDefault()
    matterhubbeAutoNames()
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
    var startButton = target.closest('#bt_matterhubbeStartDaemon')
    if (startButton.classList.contains('disabled')) { return }
    startButton.classList.add('disabled')
    startButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> {{Démarrage…}}'
    jeedom.plugin.deamonStart({
      id: 'matterhubbe',
      forceRestart: 1,
      error: function (error) {
        jeedomUtils.showAlert({ message: error.message, level: 'danger' })
        matterhubbeLoadStatus()
      },
      success: function () { matterhubbeSchedulePoll(2000) }
    })
    return
  }
  if (target.closest('#bt_matterhubbeOpenCommissioning') !== null) {
    _event.preventDefault()
    matterhubbeAjax('openCommissioning', { id: matterhubbeBridgeId }, function (_message) {
      jeedomUtils.showAlert({ message: _message || '{{Appairage ouvert pour 15 minutes : ajoutez le pont depuis l\'application avec le code affiché.}}', level: 'success' })
      matterhubbeSchedulePoll(1500)
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
  if (_event.target.id === 'sel_matterhubbeObject' || _event.target.id === 'sel_matterhubbeFamily') {
    matterhubbeFilter()
    return
  }
  var tr = _event.target.closest('#table_matterhubbeDevices tr.matterhubbeDevice')
  if (tr === null) { return }
  if (_event.target.classList.contains('matterhubbeSelect')) {
    var options = tr.querySelector('.matterhubbeOptions')
    if (options) { options.style.display = _event.target.checked ? '' : 'none' }
  }
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

/* Nos boutons sont des liens sans adresse : Entrée et Espace les déclenchent comme un clic. */
if (window.matterhubbeOnKey) {
  matterhubbeContainer.removeEventListener('keydown', window.matterhubbeOnKey)
}
window.matterhubbeOnKey = function (_event) {
  if ((_event.key === 'Enter' || _event.key === ' ') && _event.target.matches('[id^="bt_matterhubbe"][role="button"]')) {
    _event.preventDefault()
    _event.target.click()
  }
}
matterhubbeContainer.addEventListener('keydown', window.matterhubbeOnKey)
matterhubbeContainer.addEventListener('click', window.matterhubbeOnClick)
matterhubbeContainer.addEventListener('change', window.matterhubbeOnChange)
matterhubbeContainer.addEventListener('input', window.matterhubbeOnInput)
