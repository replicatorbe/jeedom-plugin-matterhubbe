<?php
if (!isConnect('admin')) {
	throw new Exception('{{401 - Accès non autorisé}}');
}
$plugin = plugin::byId('matterhubbe');
sendVarToJS('eqType', $plugin->getId());
$eqLogics = eqLogic::byType($plugin->getId());
?>

<div class="row row-overflow">
	<div class="col-xs-12 eqLogicThumbnailDisplay">
		<legend><i class="fas fa-cog"></i> {{Gestion}}</legend>
		<div class="eqLogicThumbnailContainer">
			<div class="cursor eqLogicAction logoPrimary" data-action="add">
				<i class="fas fa-plus-circle"></i>
				<br>
				<span>{{Ajouter un pont}}</span>
			</div>
			<div class="cursor eqLogicAction logoSecondary" data-action="gotoPluginConf">
				<i class="fas fa-wrench"></i>
				<br>
				<span>{{Configuration}}</span>
			</div>
		</div>

		<legend><i class="fas fa-project-diagram"></i> {{Mes ponts Matter}}</legend>
		<?php
		/* Le mode d'emploi reste affiché tant qu'aucun pont n'est appairé. */
		$anyPaired = false;
		foreach ($eqLogics as $eqLogic) {
			$status = $eqLogic->getCache('matter_status', array());
			$anyPaired = $anyPaired || !empty($status['commissioned']);
		}
		if (!$anyPaired) {
			$dependancy = $plugin->dependancy_info();
			echo '<div class="alert alert-info" style="margin:5px;">';
			echo '<b>{{Mise en route :}}</b>';
			echo '<ol style="margin:5px 0 0 0;padding-left:20px;">';
			if ($dependancy['state'] == 'ok') {
				echo '<li><s>{{Dépendances}}</s> <i class="fas fa-check"></i></li>';
			} elseif ($dependancy['state'] == 'in_progress') {
				echo '<li>{{Installation des dépendances en cours (Node.js et la bibliothèque Matter) : jusqu\'à une vingtaine de minutes, rien à faire en attendant.}}</li>';
			} else {
				echo '<li>{{Installez les dépendances : bouton « Configuration » ci-dessus, puis « Relancer » dans le cadre Dépendances.}}</li>';
			}
			echo '<li>{{Déclarez le pont, une seule fois et gratuitement, dans la Google Home Developer Console (site en anglais), avec le compte Google de la maison : projet → Add Matter integration, Vendor ID 0xFFF1, Product ID 0x8000. Sans cela, Google refuse l\'appareil.}} <a href="https://console.home.google.com/" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> console.home.google.com</a></li>';
			if (count($eqLogics) == 0) {
				echo '<li>{{Cliquez sur « Ajouter un pont » : un seul suffit pour Google Home.}}</li>';
			} else {
				echo '<li>{{Ouvrez le pont ci-dessous, onglet « Appareils exposés » : cochez les équipements à envoyer vers Google, puis enregistrez.}}</li>';
			}
			echo '<li>{{Onglet « Pont » : dans l\'application Google Home (téléphone sur le même Wi-Fi que le hub Google), Ajouter → Appareil Matter, puis scannez le QR code.}}</li>';
			echo '<li>{{Rangez les appareils dans leurs pièces, puis essayez : « Ok Google, allume le plafonnier du salon ».}}</li>';
			echo '</ol>';
			echo '</div>';
		}
		echo '<div class="input-group" style="margin:5px;">';
		echo '<input class="form-control roundedLeft" placeholder="{{Rechercher}}" id="in_searchEqlogic">';
		echo '<div class="input-group-btn">';
		echo '<a id="bt_resetSearch" class="btn" style="width:30px"><i class="fas fa-times"></i></a>';
		echo '<a class="btn roundedRight hidden" id="bt_pluginDisplayAsTable" data-coreSupport="1" data-state="0"><i class="fas fa-grip-lines"></i></a>';
		echo '</div>';
		echo '</div>';
		echo '<div class="eqLogicThumbnailContainer">';
		$daemonOk = matterhubbe::deamon_info()['state'] == 'ok';
		foreach ($eqLogics as $eqLogic) {
			$opacity = ($eqLogic->getIsEnable()) ? '' : 'disableCard';
			echo '<div class="eqLogicDisplayCard cursor ' . $opacity . '" data-eqLogic_id="' . $eqLogic->getId() . '">';
			echo '<img src="' . $plugin->getPathImgIcon() . '">';
			echo '<br>';
			echo '<span class="name">' . $eqLogic->getHumanName(true, true) . '</span>';
			if ($eqLogic->getIsEnable()) {
				$status = $eqLogic->getCache('matter_status', array());
				$paired = !empty($status['commissioned']);
				if (!$daemonOk) {
					echo '<br><span class="label label-danger">{{Démon arrêté}}</span>';
				} else {
					echo '<br><span class="label ' . ($paired ? 'label-success' : 'label-warning') . '">'
					   . ($paired ? '{{Appairé}}' : '{{Non appairé}}') . '</span>';
				}
				echo ' <span class="label label-default">' . count($eqLogic->getSelection()) . ' {{appareil(s)}}</span>';
			}
			echo '<span class="hiddenAsCard displayTableRight hidden">';
			echo '<span class="label label-info">{{Port}} ' . (int) $eqLogic->getConfiguration('port') . '</span> ';
			echo '<span class="label label-default">' . count($eqLogic->getSelection()) . ' {{appareil(s)}}</span>';
			echo '</span>';
			echo '</div>';
		}
		echo '</div>';
		?>
	</div>

	<div class="col-xs-12 eqLogic" style="display: none;">
		<div class="input-group pull-right" style="display:inline-flex">
			<span class="input-group-btn">
				<a class="btn btn-default btn-sm eqLogicAction roundedLeft" data-action="configure"><i class="fas fa-cogs"></i><span class="hidden-xs"> {{Configuration avancée}}</span></a>
				<a class="btn btn-sm btn-success eqLogicAction" data-action="save"><i class="fas fa-check-circle"></i> {{Sauvegarder}}</a>
				<a class="btn btn-sm btn-danger eqLogicAction roundedRight" data-action="remove"><i class="fas fa-minus-circle"></i> {{Supprimer}}</a>
			</span>
		</div>
		<ul class="nav nav-tabs" role="tablist">
			<li role="presentation"><a href="#" class="eqLogicAction" aria-controls="home" role="tab" data-toggle="tab" data-action="returnToThumbnailDisplay"><i class="fas fa-arrow-circle-left"></i></a></li>
			<li role="presentation" class="active"><a href="#eqlogictab" aria-controls="home" role="tab" data-toggle="tab"><i class="fas fa-project-diagram"></i><span class="hidden-xs"> {{Pont}}</span></a></li>
			<li role="presentation"><a href="#devicestab" aria-controls="home" role="tab" data-toggle="tab"><i class="fas fa-lightbulb"></i><span class="hidden-xs"> {{Appareils exposés}}</span> <span class="badge" id="span_matterhubbeCount">0</span></a></li>
			<li role="presentation"><a href="#commandtab" aria-controls="home" role="tab" data-toggle="tab"><i class="fas fa-list"></i><span class="hidden-xs"> {{Commandes}}</span></a></li>
		</ul>

		<div class="tab-content">
			<div role="tabpanel" class="tab-pane active" id="eqlogictab">
				<br>
				<div class="col-lg-6">
					<form class="form-horizontal">
						<fieldset>
							<legend><i class="fas fa-tag"></i> {{Général}}</legend>
							<div class="form-group">
								<label class="col-sm-3 control-label">{{Nom}}</label>
								<div class="col-sm-6">
									<input type="text" class="eqLogicAttr form-control" data-l1key="id" style="display:none;">
									<input type="text" class="eqLogicAttr form-control" data-l1key="name" placeholder="{{Jeedom}}">
								</div>
								<div class="col-sm-3">
									<span class="help-block" style="margin:0;">{{Nom du pont dans Google Home.}}</span>
								</div>
							</div>
							<div class="form-group">
								<label class="col-sm-3 control-label">{{Objet parent}}</label>
								<div class="col-sm-6">
									<select class="eqLogicAttr form-control" data-l1key="object_id">
										<option value="">{{Aucun}}</option>
										<?php
										foreach ((jeeObject::buildTree(null, false)) as $object) {
											echo '<option value="' . $object->getId() . '">' . $object->getHumanName(true, true) . '</option>';
										}
										?>
									</select>
								</div>
							</div>
							<div class="form-group">
								<label class="col-sm-3 control-label">{{Activer}}</label>
								<div class="col-sm-8">
									<input type="checkbox" class="eqLogicAttr" data-l1key="isEnable" checked>
								</div>
							</div>
							<div class="form-group">
								<label class="col-sm-3 control-label">{{Visible}}</label>
								<div class="col-sm-8">
									<input type="checkbox" class="eqLogicAttr" data-l1key="isVisible" checked>
								</div>
							</div>
							<div class="form-group">
								<label class="col-sm-3 control-label">{{Port Matter}}</label>
								<div class="col-sm-3">
									<input type="number" class="eqLogicAttr form-control" data-l1key="configuration" data-l2key="port" placeholder="5540">
								</div>
								<div class="col-sm-6">
									<span class="help-block" style="margin:0;">{{Port UDP du pont, 5540 par défaut ; chaque pont a le sien. À ne changer que s'il est déjà pris par un autre logiciel.}}</span>
								</div>
							</div>
						</fieldset>
					</form>
				</div>

				<div class="col-lg-6">
					<form class="form-horizontal">
						<fieldset>
							<legend>
								<i class="fas fa-qrcode"></i> {{Appairage}}
								<a class="btn btn-default btn-xs pull-right" id="bt_matterhubbeRefresh"><i class="fas fa-sync"></i> {{Actualiser}}</a>
							</legend>
							<div id="div_matterhubbeStatus" aria-live="polite">
								<span class="help-block">{{Enregistrez le pont : le code d'appairage apparaît ici quand le démon l'a démarré.}}</span>
							</div>
						</fieldset>
					</form>
				</div>
			</div>

			<div role="tabpanel" class="tab-pane" id="devicestab">
				<br>
				<div class="col-xs-12">
					<ul class="help-block" style="padding-left:20px;">
						<li>{{Cochez les équipements à envoyer vers Google Home, puis enregistrez : ils apparaissent dans l'application sans réappairer, à ranger dans leur pièce.}}</li>
						<li>{{La liste vient des types génériques des commandes : un équipement absent n'en a pas d'exploitable (Outils → Types génériques).}}</li>
						<li>{{« Apparaît comme » : un relais qui commande un plafonnier sera mieux en Lumière qu'en Prise. Changer ce choix plus tard recrée l'appareil dans Google.}}</li>
						<li>{{Le nom est celui de l'appareil dans Google (32 caractères au plus) ; vide, c'est celui de l'équipement. Préférez des noms uniques et parlants : « Plafonnier salon » plutôt que « Plafonnier ».}}</li>
					</ul>
					<div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap;">
						<a class="btn btn-success btn-sm" id="bt_matterhubbeSuggest" role="button" tabindex="0" title="{{Coche lumières, prises, volets, thermostats, serrures, ouvertures et vraies sondes ; laisse de côté ce qu'un « éteins tout » ne doit pas couper (modem, VMC, chaudière, portail…).}}"><i class="fas fa-magic"></i> {{Proposer une sélection}}</a>
						<a class="btn btn-default btn-sm" id="bt_matterhubbeAutoNames" role="button" tabindex="0" title="{{Remplit les noms vides des appareils cochés avec un nom lisible, modifiable ensuite.}}"><i class="fas fa-i-cursor"></i> {{Noms automatiques}}</a>
						<select class="form-control input-sm" id="sel_matterhubbeObject" style="width:auto;" aria-label="{{Pièce}}"><option value="">{{Toutes les pièces}}</option></select>
						<select class="form-control input-sm" id="sel_matterhubbeFamily" style="width:auto;" aria-label="{{Fonction}}"><option value="">{{Toutes les fonctions}}</option></select>
					</div>
					<span class="help-block" style="margin-top:0;">{{« Proposer » coche ce qui est utile dans Google, sans ce qu'un « éteins tout » ne doit pas couper ; « Noms automatiques » remplit les noms vides. Relisez puis enregistrez.}}</span>
					<div class="input-group" style="margin-bottom:10px;">
						<input class="form-control roundedLeft" placeholder="{{Filtrer par nom, objet, plugin ou fonction}}" id="in_matterhubbeFilter">
						<span class="input-group-btn">
							<a class="btn btn-default" id="bt_matterhubbeCheckVisible" role="button" tabindex="0" title="{{Cocher les lignes affichées}}" aria-label="{{Cocher les lignes affichées}}"><i class="far fa-check-square"></i></a>
							<a class="btn btn-default" id="bt_matterhubbeUncheckVisible" role="button" tabindex="0" title="{{Décocher les lignes affichées}}" aria-label="{{Décocher les lignes affichées}}"><i class="far fa-square"></i></a>
							<a class="btn btn-default" id="bt_matterhubbeOnlySelected" data-state="0" role="button" tabindex="0" aria-pressed="false" title="{{Afficher seulement les appareils cochés}}"><i class="fas fa-filter"></i> {{Cochés}}</a>
							<a class="btn btn-default roundedRight" id="bt_matterhubbeReloadCandidates" role="button" tabindex="0" title="{{Relire les équipements}}" aria-label="{{Relire les équipements}}"><i class="fas fa-sync"></i></a>
						</span>
					</div>
					<div class="table-responsive">
						<table id="table_matterhubbeDevices" class="table table-bordered table-condensed">
							<thead>
								<tr>
									<th style="width:40px;"></th>
									<th>{{Équipement}}</th>
									<th style="width:140px;">{{Fonction}}</th>
									<th style="width:190px;">{{Apparaît comme}}</th>
									<th style="width:260px;">{{Nom dans Google Home}}</th>
								</tr>
							</thead>
							<tbody></tbody>
						</table>
					</div>
				</div>
			</div>

			<div role="tabpanel" class="tab-pane" id="commandtab">
				<br>
				<div class="col-xs-12">
					<table id="table_cmd" class="table table-bordered table-condensed">
						<thead>
							<tr>
								<th style="width:300px;">{{Nom}}</th>
								<th style="width:130px;">{{Type}}</th>
								<th>{{Paramètres}}</th>
								<th style="width:120px;">{{Actions}}</th>
							</tr>
						</thead>
						<tbody></tbody>
					</table>
				</div>
			</div>
		</div>
	</div>
</div>

<?php include_file('desktop', 'matterhubbe', 'js', 'matterhubbe'); ?>
<?php include_file('core', 'plugin.template', 'js'); ?>
