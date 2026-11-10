import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {assertOwnedFixture} from './ha-edge.mjs';
for (const [variable,label] of [['LIGHTNVR_HA_FIXTURE','T10-HA'],['LIGHTNVR_PROBE_FIXTURE','T1']]) {
 const path=process.env[variable];if(!path)continue;
 const f=JSON.parse(await readFile(path,'utf8'));
 const info=assertOwnedFixture(f,label);
 const network=f.container+'-net';
 if(!Object.hasOwn(info.NetworkSettings.Networks,network))throw Error('Owned network identity differs; inspect manually');
 const args=f.podman_args??[];
 execFileSync('podman',[...args,'rm','-f',f.container],{stdio:'ignore'});
 execFileSync('podman',[...args,'network','rm',network],{stdio:'ignore'});
 console.log('Removed matched disposable '+label+' container and network');
}
