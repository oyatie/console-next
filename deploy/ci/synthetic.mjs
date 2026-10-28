// SPDX-License-Identifier: LicenseRef-Proprietary
// Ephemeral cluster credentials are streamed directly to kubectl; never written to evidence or the artifact.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
assert.match(execFileSync('kubectl',['config','current-context'],{encoding:'utf8'}),/^kind-platform-/);
const roles = {app:'console_app',rt:'console_rt',leave:'console_leave_cmd',ontology:'console_ontology_cmd',force:'console_platform_force_cmd'};
const passwords = Object.fromEntries(Object.keys(roles).map(key=>[key,randomBytes(32).toString('hex')]));
const url = role => `postgresql://${roles[role]}:${passwords[role]}@console-db-rw:5432/console`;
const keys = generateKeyPairSync('ec',{namedCurve:'prime256v1',privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const secrets = Object.entries(roles).map(([key,username])=>({name:`${key}-role`,type:'kubernetes.io/basic-auth',values:{username,password:passwords[key]}}));
secrets.push({name:'api',values:{DATABASE_URL:url('rt'),LEAVE_COMMAND_DATABASE_URL:url('leave'),ONTOLOGY_COMMAND_DATABASE_URL:url('ontology'),PLATFORM_FORCE_COMMAND_DATABASE_URL:url('force'),CONSOLE_JWT_PRIVATE_KEY_PEM:keys.privateKey,CONSOLE_JWT_PUBLIC_KEY_PEM:keys.publicKey,CONSOLE_COLDSTART_OTP:randomBytes(24).toString('hex')}});
secrets.push({name:'worker',values:{DATABASE_URL:url('rt'),PLATFORM_FORCE_COMMAND_DATABASE_URL:url('force')}},{name:'migrate',values:{DATABASE_URL:url('app')}});
const access=randomBytes(16).toString('hex'), secret=randomBytes(32).toString('hex');
secrets.push({name:'object-credentials',values:{ACCESS_KEY_ID:access,ACCESS_SECRET_KEY:secret}},{name:'object-auth',values:{'config.json':JSON.stringify({identities:[{name:'synthetic',credentials:[{accessKey:access,secretKey:secret}],actions:['Admin','Read','Write','List','Tagging']}]})}});
for (const item of secrets) execFileSync('kubectl',['apply','-f','-'],{input:JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{name:`console-${item.name}`,namespace:'console',labels:{'cnpg.io/reload':'true'}},type:item.type??'Opaque',stringData:item.values}),stdio:['pipe','ignore','inherit']});
