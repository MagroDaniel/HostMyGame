// Periodically checks whether newer server builds exist and flags instances with updateAvailable.
import { save } from './store.js';
import { appInfo, installedBuild, latestBuild } from './providers/steamcmd.js';
import { latestMinecraft } from './providers/minecraft.js';
import { latestDownload } from './providers/download.js';

let lastCheck = 0;
let checking = null;

export function lastUpdateCheck() { return lastCheck; }

export function checkUpdates(instances) {
  if (checking) return checking;
  checking = (async () => {
    const list = [...instances].filter(i => i.cfg.installed);
    const steam = list.filter(i => i.template.provider === 'steamcmd' && i.steamAppId);
    const appIds = [...new Set(steam.map(i => i.steamAppId))];
    if (appIds.length) {
      try {
        const info = await appInfo(appIds);
        for (const inst of steam) {
          const latest = latestBuild(info[inst.steamAppId], inst.cfg.steamBranch);
          const current = installedBuild(inst.dir, inst.steamAppId);
          inst.cfg.updateAvailable = Boolean(latest && current && latest !== current);
          inst.cfg.latestBuild = latest;
        }
      } catch (e) {
        console.error('Verificação de atualizações (Steam) falhou:', e.message);
      }
    }
    for (const inst of list.filter(i => ['minecraft', 'download'].includes(i.template.provider))) {
      try {
        const latest = inst.template.provider === 'minecraft' ? await latestMinecraft(inst) : await latestDownload(inst);
        if (!latest) { inst.cfg.updateAvailable = false; continue; }
        const cur = inst.cfg.installed;
        inst.cfg.updateAvailable = Boolean((latest.version && latest.version !== cur.version) || (latest.build && String(latest.build) !== String(cur.build)));
      } catch (e) {
        console.error(`Verificação de atualizações (${inst.cfg.name}) falhou:`, e.message);
      }
    }
    lastCheck = Date.now();
    save();
  })().finally(() => { checking = null; });
  return checking;
}
