import {isAdmin} from './configUtils';
import {guiMenus, markSitchDirty, Sit} from './Globals';
import {normalizeTemplateOptions, TEMPLATE_PRESETS, templateOptions} from './TemplateOptions';

export function setupTemplateOptionsMenu() {
    if (!isAdmin() || !guiMenus.file) return;
    const folder = guiMenus.file.addFolder('Template Options').close()
        .tooltip('Actions saved with Save as Template and applied for everyone who starts from that template.');
    const write = changes => {
        if (!isAdmin()) return;
        Sit.templateOptions = normalizeTemplateOptions({...templateOptions(Sit), ...changes});
        markSitchDirty();
    };
    const presets = folder.addFolder('Presets').close();
    for (const [name, options] of Object.entries(TEMPLATE_PRESETS)) {
        presets.add({apply: () => write(options)}, 'apply').name(name)
            .tooltip('Set the template actions below. Save as Template to publish them with the template.');
    }
    const proxy = {};
    for (const key of Object.keys(templateOptions(Sit))) Object.defineProperty(proxy, key, {
        get: () => templateOptions(Sit)[key], set: value => write({[key]: value}), enumerable: true,
    });
    const imported = folder.addFolder('On Media Import').open();
    imported.add(proxy, 'analyzeImages').name('Analyze Stars in Images').listen()
        .tooltip('Run Star Tracker after a new image finishes loading. Existing location and time remain constraints.');
    imported.add(proxy, 'analyzeVideos').name('Analyze Stars in Videos').listen()
        .tooltip('Run Star Tracker over the imported video range. The analysis can be stopped.');
    const solved = folder.addFolder('After Star Identification').open();
    solved.add(proxy, 'findNightView').name('Find Nighttime View').listen()
        .tooltip('Use the solved star field to choose missing viewing location or time. Preserve user edits and metadata. Prefer the United States, then Europe. These are viewing assumptions, not a recovered photo location or date.');
    solved.add(proxy, 'frameStars').name('Frame Solved Stars').listen()
        .tooltip('Match the look camera to the solved field of view and orientation.');
    const known = folder.addFolder('Known Template Values').close();
    known.add(proxy, 'keepLocation').name('Keep Template Location').listen()
        .tooltip('Treat the location saved in this template as known. Otherwise the initial location is only a starting view.');
    known.add(proxy, 'keepTime').name('Keep Template Time').listen()
        .tooltip('Treat the date and time saved in this template as known. User edits and imported metadata are always preserved.');
    folder.add(proxy, 'satellites', {'Use saved setting': 'inherit', 'Load on request': 'manual', 'Load automatically': 'automatic'})
        .name('Satellite Loading').listen()
        .tooltip('On the next template load: keep its satellite setting, start without catalogs and load on request, or load automatically for the viewing date.');
}
